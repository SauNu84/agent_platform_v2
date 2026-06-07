/**
 * Slice-0 benchmark harness (ADR-003).
 *
 * Drives a RealtimeSession from the fixed fixture, records event timestamps, and
 * computes the decision-grade metrics: TTFA p50/p95, barge-in stop, mid-turn
 * tool-calling dead-air, and cost/conversation-minute. Vendor-neutral: it only
 * touches the `realtime-interface.ts` contract, so a vendor = one adapter file.
 *
 *   tsx bench.ts --vendor <mock|openai|gemini|livekit> [--turns 50]
 *                [--fixture fixtures/manifest.json] [--realtime]
 *
 * `--realtime` paces mic audio at 1x (REQUIRED for live vendor runs). Omit it for
 * the offline mock self-test so frames stream as fast as possible.
 *
 * The metric extraction (computeTurnMetric / percentile / costPerConversationMinute)
 * is pure and unit-tested in harness.test.ts.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RealtimeVoiceProvider, RealtimeSession, SessionEvent, CompiledScenario, Transcript,
  SessionUsage, TurnUsage,
} from './realtime-interface.ts';
import {
  loadManifest, readWavPcm, sliceMs, hasRealAudio,
  type FixtureManifest, type FixtureTurn,
} from './fixtures/fixture.ts';
import { loadDotEnv } from './load-env.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Trailing silence (ms) appended after each user utterance so server-side VAD
// detects end-of-speech and auto-commits the turn. Must exceed the adapter's
// turn_detection.silence_duration_ms (500ms) with margin for prefix padding.
const VAD_FLUSH_MS = 800;

// The server-VAD endpoint window we configure on every S2S vendor (OpenAI + Gemini).
// TTFA (gross) includes this fixed endpoint-detection delay; "net-of-VAD" TTFA =
// gross − VAD_SILENCE_MS isolates the model+TTS inference latency, the apples-to-apples
// number the CTO wants for the CPO product-bar conversation (SAU-176). Env-overridable.
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS) || 500;

// One hardcoded Scenario for Slice-0 (the thinnest path).
const SCENARIO: CompiledScenario = {
  id: 'slice0-sales-objection',
  name: 'Sales Objection (Slice-0)',
  aiInstructions: 'You are a skeptical enterprise buyer. Reply in ONE short sentence (≤12 words). When asked about pricing, CALL the `lookupPrice` tool and keep speaking a few words until the result arrives.',
  voice: { name: 'Aoede', languageCode: 'en-US' },
  tools: [{
    name: 'lookupPrice',
    description: 'Look up the current price for a SKU (forces a mid-turn tool call).',
    paramsSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
    sideEffect: 'server',
  }],
};

export interface TurnMetric {
  index: number;
  kind: FixtureTurn['kind'];
  ttfaMs: number | null;
  bargeInStopMs: number | null;
  toolDeadAirMs: number | null;
}

// ── PURE metric math (unit-tested) ───────────────────────────────────────────

export function percentile(xs: Array<number | null | undefined>, p: number): number | null {
  const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  // nearest-rank
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length - 1, Math.max(0, rank - 1))];
}

/**
 * Extract one turn's metrics from the ordered event window captured AFTER the
 * harness marked `userUtteranceEnd` (the moment the last mic frame was sent).
 *   ttfaMs        = first 'audio.output'.at − userUtteranceEnd
 *   bargeInStopMs = 'agent.interrupted'.at − 'user.speech.started'.at
 *   toolDeadAirMs = largest gap with NO 'audio.output' inside [tool.call, tool.result]
 */
export function computeTurnMetric(
  turn: FixtureTurn,
  userUtteranceEnd: number,
  window: SessionEvent[],
): TurnMetric {
  const firstAudio = window.find((e) => e.type === 'audio.output');
  const ttfaMs = firstAudio ? firstAudio.at - userUtteranceEnd : null;

  let bargeInStopMs: number | null = null;
  const speechStarted = window.find((e) => e.type === 'user.speech.started');
  const interrupted = window.find((e) => e.type === 'agent.interrupted');
  if (speechStarted && interrupted) bargeInStopMs = interrupted.at - speechStarted.at;

  let toolDeadAirMs: number | null = null;
  const call = window.find((e) => e.type === 'tool.call');
  const res = window.find((e) => e.type === 'tool.result');
  if (call && res) {
    // audio frames bracketing the tool window; measure the largest silent gap.
    const marks = [
      call.at,
      ...window.filter((e) => e.type === 'audio.output' && e.at >= call.at && e.at <= res.at).map((e) => e.at),
      res.at,
    ].sort((a, b) => a - b);
    let max = 0;
    for (let i = 1; i < marks.length; i++) max = Math.max(max, marks[i] - marks[i - 1]);
    toolDeadAirMs = max;
  }

  return { index: turn.index, kind: turn.kind, ttfaMs, bargeInStopMs, toolDeadAirMs };
}

// ── Cost model (rates per vendor from ADR-003 rate cards) ─────────────────────
export interface RateCard {
  label: string;
  audioInPerMin: number;
  audioOutPerMin: number;
  infraPerMin: number;
  /** accumulating-context multiplier — S2S models re-bill growing context per turn */
  contextMultiplier?: number;
}
export function costPerConversationMinute(rc: RateCard): number {
  const m = rc.contextMultiplier ?? 1.4;
  return (rc.audioInPerMin + rc.audioOutPerMin) * m + rc.infraPerMin;
}

// ── MEASURED cost model (SAU-197): real tokens × published per-token rates ─────
// USD per 1,000,000 tokens. Source + date recorded on every report so the rate
// attribution is auditable. Audio dominates a voice session (~99% of tokens), so
// the text-output rate ambiguity between gpt-realtime ($16) and gpt-realtime-2
// ($24) moves the total by <1% — the audio rates are identical across both.
export interface RealtimeRate {
  textIn: number; textCachedIn: number; textOut: number;
  audioIn: number; audioCachedIn: number; audioOut: number;
}
export const REALTIME_RATES_SOURCE =
  'OpenAI published pricing (developers.openai.com/api/docs/pricing), fetched 2026-06-07';
export const REALTIME_RATES: Record<string, RealtimeRate> = {
  // gpt-realtime (GA S2S) — the model the bench targets by default.
  'gpt-realtime':   { textIn: 4.0, textCachedIn: 0.4, textOut: 16.0, audioIn: 32.0, audioCachedIn: 0.4, audioOut: 64.0 },
  // gpt-realtime-2 — same audio rates, higher text output.
  'gpt-realtime-2': { textIn: 4.0, textCachedIn: 0.4, textOut: 24.0, audioIn: 32.0, audioCachedIn: 0.4, audioOut: 64.0 },
};
/** Pick the rate table for a (possibly versioned) model id; default to gpt-realtime. */
export function ratesForModel(model: string | undefined): { id: string; rates: RealtimeRate } {
  if (model && REALTIME_RATES[model]) return { id: model, rates: REALTIME_RATES[model] };
  if (model && model.startsWith('gpt-realtime-2')) return { id: 'gpt-realtime-2', rates: REALTIME_RATES['gpt-realtime-2'] };
  return { id: 'gpt-realtime', rates: REALTIME_RATES['gpt-realtime'] };
}

/** USD cost of one TurnUsage (or summed totals) at the given per-1M rates.
 *  Cached input tokens are a SUBSET of input tokens, billed at the cached rate;
 *  the uncached remainder is billed at the full rate. */
export function usageCost(u: TurnUsage, r: RealtimeRate): number {
  const uncachedAudioIn = Math.max(0, u.inputAudioTokens - u.cachedAudioTokens);
  const uncachedTextIn = Math.max(0, u.inputTextTokens - u.cachedTextTokens);
  const tokensTimesRate =
    uncachedAudioIn * r.audioIn +
    u.cachedAudioTokens * r.audioCachedIn +
    uncachedTextIn * r.textIn +
    u.cachedTextTokens * r.textCachedIn +
    u.outputAudioTokens * r.audioOut +
    u.outputTextTokens * r.textOut;
  return tokensTimesRate / 1_000_000;
}

/** Cost if NO input had been cached (everything billed at full input rate). */
export function usageCostUncached(u: TurnUsage, r: RealtimeRate): number {
  const full: TurnUsage = { ...u, cachedAudioTokens: 0, cachedTextTokens: 0 };
  return usageCost(full, r);
}

/**
 * Project session cost to a target wall-clock length WITH context accumulation.
 * S2S models re-bill the growing context each turn, so later turns cost more.
 * We fit a linear trend cost(i)=a+b·i over the observed per-turn cost series and
 * sum it out to the turn count that fills `targetMin` at the observed turn cadence.
 * Returns $/conv-min at the target length. (b>0 captures the accumulation slope.)
 */
export function projectCostPerMin(
  perTurnCosts: number[], observedDurationMin: number, targetMin: number,
): number {
  const N = perTurnCosts.length;
  if (!N || observedDurationMin <= 0) return 0;
  const turnsPerMin = N / observedDurationMin;
  const targetTurns = Math.max(N, Math.round(turnsPerMin * targetMin));
  // least-squares fit cost(i) = a + b·i  (i = 0..N-1)
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += perTurnCosts[i]; sxx += i * i; sxy += i * perTurnCosts[i]; }
  const denom = N * sxx - sx * sx;
  const b = denom === 0 ? 0 : (N * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / N;
  let projected = 0;
  for (let i = 0; i < targetTurns; i++) projected += Math.max(0, a + b * i);
  return projected / targetMin;
}

export type CostBand = '🟢' | '🟡' | '🔴';
export function costBand(perConvMin: number): CostBand {
  if (perConvMin <= 0.09) return '🟢';
  if (perConvMin <= 0.15) return '🟡';
  return '🔴';
}

export interface MeasuredCost {
  model: string;
  ratesUsd1M: RealtimeRate;
  ratesAsOf: string;
  turnsWithUsage: number;
  sessionDurationMin: number;
  totals: TurnUsage;
  inputTokensTotal: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cachedInputPct: number;        // % of input tokens served from cache
  cachingReductionPct: number;   // % cost reduction vs all-uncached input
  sessionCostUsd: number;
  measuredCostPerConvMin: number;       // as-run (observed session length)
  projected6MinCostPerConvMin: number;  // 6-min projection w/ context accumulation
  band6Min: CostBand;
}

/** Compute the full measured-cost block from captured session usage. */
export function computeMeasuredCost(
  usage: SessionUsage, model: string | undefined, sessionDurationMin: number,
): MeasuredCost {
  const { id, rates } = ratesForModel(model);
  const t = usage.totals;
  const inputTokensTotal = t.inputTextTokens + t.inputAudioTokens;
  const cachedInputTokens = t.cachedTextTokens + t.cachedAudioTokens;
  const uncachedInputTokens = Math.max(0, inputTokensTotal - cachedInputTokens);
  const sessionCostUsd = usageCost(t, rates);
  const sessionCostUncached = usageCostUncached(t, rates);
  const perTurnCosts = usage.perTurn.map((u) => usageCost(u, rates));
  const measuredCostPerConvMin = sessionDurationMin > 0 ? sessionCostUsd / sessionDurationMin : 0;
  const projected6MinCostPerConvMin = projectCostPerMin(perTurnCosts, sessionDurationMin, 6);
  return {
    model: id,
    ratesUsd1M: rates,
    ratesAsOf: REALTIME_RATES_SOURCE,
    turnsWithUsage: usage.perTurn.length,
    sessionDurationMin,
    totals: t,
    inputTokensTotal,
    cachedInputTokens,
    uncachedInputTokens,
    cachedInputPct: inputTokensTotal > 0 ? (cachedInputTokens / inputTokensTotal) * 100 : 0,
    cachingReductionPct: sessionCostUncached > 0 ? (1 - sessionCostUsd / sessionCostUncached) * 100 : 0,
    sessionCostUsd,
    measuredCostPerConvMin,
    projected6MinCostPerConvMin,
    band6Min: costBand(projected6MinCostPerConvMin),
  };
}

// ── Event buffer: pumps the session stream, lets the driver wait/window ───────
class EventBuffer {
  private all: SessionEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  constructor(events: AsyncIterable<SessionEvent>) {
    void (async () => {
      for await (const e of events) {
        this.all.push(e);
        const ws = this.waiters; this.waiters = []; ws.forEach((w) => w());
      }
      this.closed = true;
      const ws = this.waiters; this.waiters = []; ws.forEach((w) => w());
    })();
  }
  since(fromAt: number): SessionEvent[] {
    return this.all.filter((e) => e.at >= fromAt);
  }
  async waitFor(pred: (e: SessionEvent) => boolean, timeoutMs: number): Promise<SessionEvent | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.all.find(pred);
      if (hit) return hit;
      if (this.closed || Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())));
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }
  /**
   * Wait until the agent has been silent for `quietMs` (no new audio.output), or
   * timeout. This isolates turn boundaries: it drains the previous turn's trailing
   * audio so the NEXT turn's `userUtteranceEnd` marker sees a clean window and TTFA
   * is measured against this turn's first frame, not a stray leftover frame.
   */
  async waitForQuiescence(quietMs: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let lastAudioAt = -Infinity;
      for (let i = this.all.length - 1; i >= 0; i--) {
        if (this.all[i].type === 'audio.output') { lastAudioAt = this.all[i].at; break; }
      }
      const sinceLast = lastAudioAt === -Infinity ? Infinity : Date.now() - lastAudioAt;
      if (sinceLast >= quietMs || this.closed || Date.now() >= deadline) return;
      await new Promise<void>((r) => setTimeout(r, Math.min(quietMs, 30)));
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Per-turn audio sliced from driver.wav (null ⇒ stream silence sized by userMs). */
interface TurnAudio { user: Int16Array | null; barge: Int16Array | null }

/** Stream a PCM buffer (or sized silence) into the session as frameMs chunks. */
async function streamAudio(
  session: RealtimeSession,
  manifest: FixtureManifest,
  pcm: Int16Array | null,
  fallbackMs: number,
  realtime: boolean,
): Promise<void> {
  const samplesPerFrame = Math.floor((manifest.sampleRate * manifest.frameMs) / 1000);
  if (pcm) {
    for (let o = 0; o < pcm.length; o += samplesPerFrame) {
      session.sendAudio(pcm.subarray(o, Math.min(pcm.length, o + samplesPerFrame)));
      if (realtime) await sleep(manifest.frameMs); // pace at 1x for live vendors
    }
  } else {
    const frames = Math.max(1, Math.floor(fallbackMs / manifest.frameMs));
    for (let f = 0; f < frames; f++) {
      session.sendAudio(new Int16Array(samplesPerFrame));
      if (realtime) await sleep(manifest.frameMs);
    }
  }
}

// ── Drive one turn from the fixture, extract its metrics ──────────────────────
async function driveOneTurn(
  session: RealtimeSession,
  buf: EventBuffer,
  turn: FixtureTurn,
  manifest: FixtureManifest,
  realtime: boolean,
  audio: TurnAudio,
): Promise<TurnMetric> {
  // 0. Drain the previous turn's trailing agent audio so this turn measures clean.
  if (turn.index > 0) await buf.waitForQuiescence(200, 4000);

  // 1. Replay the user's mic audio for this turn (real PCM slice, or sized silence).
  await streamAudio(session, manifest, audio.user, turn.userMs, realtime);

  // 2. End-of-user-utterance reference point for TTFA (VAD end == last frame sent).
  const userUtteranceEnd = Date.now();

  // 2b. Flush trailing silence so server-side VAD sees the end-of-speech gap and
  //     auto-commits the turn (turn_detection.create_response). The fixture slices
  //     exclude the inter-turn pause, so without this the server keeps waiting for
  //     more speech and never responds. The silence-induced wait is inherent VAD
  //     latency and is correctly attributed to TTFA (measured from userUtteranceEnd,
  //     set BEFORE this flush). Sized > turn_detection.silence_duration_ms (500ms).
  await streamAudio(session, manifest, null, VAD_FLUSH_MS, realtime);

  // 3. Wait for the agent's first audio frame of THIS turn.
  const firstAudio = await buf.waitFor(
    (e) => e.type === 'audio.output' && e.at >= userUtteranceEnd, 5000,
  );

  // 4. Barge-in: once the agent is talking, stream the user's cut-in audio over the
  //    agent's playback (so the vendor's VAD detects it) and force interrupt.
  if (turn.kind === 'bargein' && firstAudio) {
    await sleep(turn.bargeInAfterMs ?? 400);
    // Stream the real cut-in utterance over the agent so the vendor's VAD detects
    // the barge-in. (Mock has no barge clip → rely on interrupt() to avoid a
    // spurious VAD commit from streamed frames.)
    if (audio.barge) await streamAudio(session, manifest, audio.barge, 0, realtime);
    session.interrupt();
    await buf.waitFor((e) => e.type === 'agent.interrupted' && e.at >= userUtteranceEnd, 3000);
  }

  // 5. For tool turns, wait until the tool.result lands so we can measure dead-air.
  if (turn.kind === 'tool') {
    await buf.waitFor((e) => e.type === 'tool.result' && e.at >= userUtteranceEnd, 5000);
    await sleep(manifest.frameMs * 4); // let trailing audio frames arrive
  } else if (turn.kind === 'normal') {
    await sleep(manifest.frameMs * 3);
  }

  return computeTurnMetric(turn, userUtteranceEnd, buf.since(userUtteranceEnd));
}

async function runVendor(
  provider: RealtimeVoiceProvider,
  manifest: FixtureManifest,
  realtime: boolean,
  wavPath: string,
): Promise<{ metrics: TurnMetric[]; transcript: Transcript; usedRealAudio: boolean }> {
  const session = await provider.startSession(SCENARIO, { mode: modeForVendor(provider.vendor), vadSilenceMs: VAD_SILENCE_MS });
  session.registerTool(SCENARIO.tools[0], async () => ({ sku: 'PRO', price: 99 }));
  const buf = new EventBuffer(session.events);

  // Load driver.wav once and pre-slice each turn's region (real-speech fixture only).
  const usedRealAudio = hasRealAudio(manifest, wavPath);
  const wav = usedRealAudio ? readWavPcm(wavPath) : null;
  const audioFor = (turn: FixtureTurn): TurnAudio => {
    if (!wav || turn.audioDurationMs == null) return { user: null, barge: null };
    return {
      user: sliceMs(wav.pcm, wav.sampleRate, turn.audioStartMs!, turn.audioDurationMs),
      barge: turn.bargeDurationMs != null
        ? sliceMs(wav.pcm, wav.sampleRate, turn.bargeStartMs!, turn.bargeDurationMs)
        : null,
    };
  };

  const metrics: TurnMetric[] = [];
  for (const turn of manifest.turns) {
    metrics.push(await driveOneTurn(session, buf, turn, manifest, realtime, audioFor(turn)));
  }
  await buf.waitForQuiescence(200, 4000); // let the final turn's response finish
  const transcript = await session.stop(); // persists transcript — proves end-to-end
  return { metrics, transcript, usedRealAudio };
}

// ── Rate cards (published ADR-003 figures; cost is an ESTIMATE until live usage) ─
const RATE_CARDS: Record<string, RateCard> = {
  openai:  { label: 'OpenAI Realtime', audioInPerMin: 0.06, audioOutPerMin: 0.24, infraPerMin: 0.0, contextMultiplier: 1.6 },
  gemini:  { label: 'Gemini Live',     audioInPerMin: 0.01, audioOutPerMin: 0.02, infraPerMin: 0.0, contextMultiplier: 1.4 },
  livekit: { label: 'LiveKit Agents',  audioInPerMin: 0.02, audioOutPerMin: 0.06, infraPerMin: 0.01, contextMultiplier: 1.4 },
  mock:    { label: 'mock',            audioInPerMin: 0.00, audioOutPerMin: 0.00, infraPerMin: 0.0, contextMultiplier: 1.0 },
};

const VENDOR_TO_RESULTS_ROW: Record<string, string> = {
  openai: 'OpenAI Realtime',
  gemini: 'Gemini Live',
  livekit: 'LiveKit Agents',
};

/** The session mode each vendor is benchmarked in. LiveKit's only path here is the
 *  cascade (Deepgram→LLM→Cartesia), so it must NOT land in the s2s RESULTS.md row. */
function modeForVendor(vendor: string): 's2s' | 'cascade' {
  return vendor === 'livekit' ? 'cascade' : 's2s';
}

export interface BenchReport {
  vendor: string;
  mode: 's2s' | 'cascade';
  turns: number;
  ttfaP50: number | null;
  ttfaP95: number | null;
  /** TTFA net of the configured server-VAD endpoint window (isolates inference+TTS). */
  ttfaNetP50: number | null;
  ttfaNetP95: number | null;
  vadSilenceMs: number;
  bargeInStopP95: number | null;
  midTurnToolMaxDeadAirMs: number | null;
  costPerConvMin: number;
  costNote: string;
  /** Present only when the vendor reported measured token usage (SAU-197). */
  measuredCost?: MeasuredCost;
  transcriptPersisted: boolean;
  passes: { ttfa: boolean | null; bargeIn: boolean | null; tool: boolean | null };
}

export function summarize(vendor: string, metrics: TurnMetric[], transcript: Transcript): BenchReport {
  const mode = modeForVendor(vendor);
  const ttfas = metrics.map((m) => m.ttfaMs);
  const ttfaP50 = percentile(ttfas, 50);
  const ttfaP95 = percentile(ttfas, 95);
  // net-of-VAD: subtract the fixed endpoint window from each sample (floor at 0).
  const ttfasNet = ttfas.map((t) => (t == null ? null : Math.max(0, t - VAD_SILENCE_MS)));
  const ttfaNetP50 = percentile(ttfasNet, 50);
  const ttfaNetP95 = percentile(ttfasNet, 95);
  const bargeInStopP95 = percentile(metrics.map((m) => m.bargeInStopMs), 95);
  const deadAirs = metrics.map((m) => m.toolDeadAirMs).filter((x): x is number => x != null);
  const midTurnToolMaxDeadAirMs = deadAirs.length ? Math.max(...deadAirs) : null;
  const rc = RATE_CARDS[vendor] ?? RATE_CARDS.mock;
  // MEASURED cost (SAU-197): if the vendor reported token usage, compute the real
  // $/conv-min from captured tokens; otherwise fall back to the rate-card estimate.
  const sessionDurationMin = (transcript.endedAt - transcript.startedAt) / 60_000;
  const measuredCost = transcript.usage
    ? computeMeasuredCost(transcript.usage, transcript.model, sessionDurationMin)
    : undefined;
  const costNote = measuredCost
    ? `MEASURED from ${measuredCost.turnsWithUsage} response.done.usage samples × ${measuredCost.model} per-token rates (${REALTIME_RATES_SOURCE}). ` +
      `As-run ${measuredCost.measuredCostPerConvMin.toFixed(3)} $/conv-min over ${measuredCost.sessionDurationMin.toFixed(2)} min; ` +
      `6-min projection ${measuredCost.projected6MinCostPerConvMin.toFixed(3)} $/conv-min (band ${measuredCost.band6Min}); ` +
      `prompt-cache covered ${measuredCost.cachedInputPct.toFixed(1)}% of input tokens (−${measuredCost.cachingReductionPct.toFixed(1)}% cost vs uncached).`
    : 'ESTIMATE from published rate card — replace with measured usage-API tokens on the live run';
  return {
    vendor,
    mode,
    turns: metrics.length,
    ttfaP50, ttfaP95, ttfaNetP50, ttfaNetP95, vadSilenceMs: VAD_SILENCE_MS,
    bargeInStopP95, midTurnToolMaxDeadAirMs,
    costPerConvMin: measuredCost ? measuredCost.projected6MinCostPerConvMin : costPerConversationMinute(rc),
    costNote,
    measuredCost,
    transcriptPersisted: transcript.turns.length > 0,
    passes: {
      ttfa: ttfaP95 == null ? null : ttfaP95 <= 800,
      bargeIn: bargeInStopP95 == null ? null : bargeInStopP95 <= 300,
      tool: midTurnToolMaxDeadAirMs == null ? null : midTurnToolMaxDeadAirMs <= 1500,
    },
  };
}

// ── Output: archive raw JSON to ./out/, upsert RESULTS.md vendor row ──────────
function archive(report: BenchReport, metrics: TurnMetric[], transcript: Transcript): string {
  const outDir = join(HERE, 'out');
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${report.vendor}-report.json`);
  writeFileSync(path, JSON.stringify({ report, metrics, transcript }, null, 2) + '\n');
  return path;
}

function fmt(n: number | null): string {
  return n == null ? '—' : String(Math.round(n));
}

/** Upsert the vendor's row into RESULTS.md — only touches an existing matching row. */
function upsertResultsRow(report: BenchReport): boolean {
  const rowLabel = VENDOR_TO_RESULTS_ROW[report.vendor];
  if (!rowLabel) return false; // mock / unknown vendors never write to the curated table
  const resultsPath = join(HERE, 'RESULTS.md');
  if (!existsSync(resultsPath)) return false;
  const lines = readFileSync(resultsPath, 'utf8').split('\n');
  const pass = (b: boolean | null) => (b == null ? '—' : b ? '✅' : '❌');
  let wrote = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(`| ${rowLabel} | ${report.mode} `) && line.includes('—')) {
      const mode = report.mode;
      lines[i] =
        `| ${rowLabel} | ${mode} | ${fmt(report.ttfaP50)} | ${fmt(report.ttfaP95)} | ` +
        `${fmt(report.bargeInStopP95)} | ${report.midTurnToolMaxDeadAirMs == null ? '—' : `yes (${fmt(report.midTurnToolMaxDeadAirMs)} ms)`} | ` +
        `~$${report.costPerConvMin.toFixed(3)} (est) | TBD | ` +
        `${pass(report.passes.ttfa) }${pass(report.passes.bargeIn)}${pass(report.passes.tool)} |`;
      wrote = true;
      break; // first matching empty row
    }
  }
  if (wrote) writeFileSync(resultsPath, lines.join('\n'));
  return wrote;
}

// ── entry point ───────────────────────────────────────────────────────────────
function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function makeProvider(vendor: string, manifest: FixtureManifest): Promise<RealtimeVoiceProvider> {
  switch (vendor) {
    case 'mock': {
      const { MockProvider } = await import('./adapters/mock.ts');
      return new MockProvider(manifest);
    }
    case 'openai': {
      const { OpenAIRealtimeProvider } = await import('./adapters/openai.ts');
      return new OpenAIRealtimeProvider();
    }
    case 'gemini': {
      const { GeminiLiveProvider } = await import('./adapters/gemini.ts');
      return new GeminiLiveProvider();
    }
    case 'livekit': {
      const { LiveKitProvider } = await import('./adapters/livekit.ts');
      return new LiveKitProvider();
    }
    default:
      throw new Error(`unknown vendor '${vendor}' (use mock|openai|gemini|livekit)`);
  }
}

export async function main(): Promise<BenchReport> {
  // SAU-181: fill any unset vendor keys from a gitignored `.env` in this dir.
  // Exported env vars still win; this only covers vars the run env didn't inject.
  const loaded = loadDotEnv(HERE);
  if (loaded.length) console.log(`[bench] loaded from .env: ${loaded.join(', ')}`);

  const vendor = getArg('vendor') ?? 'mock';
  const turnsArg = getArg('turns');
  const fixturePath = getArg('fixture');
  const realtime = process.argv.includes('--realtime');

  const manifestPath = fixturePath ? join(process.cwd(), fixturePath) : join(HERE, 'fixtures', 'manifest.json');
  const manifest = loadManifest(manifestPath);
  if (turnsArg) manifest.turns = manifest.turns.slice(0, Number(turnsArg));
  const wavPath = join(dirname(manifestPath), manifest.wav);

  const audioMode = hasRealAudio(manifest, wavPath) ? `speech (${manifest.wav})` : 'silence/tone';
  console.log(`[bench] vendor=${vendor} turns=${manifest.turns.length} realtime=${realtime} audio=${audioMode}`);
  if (vendor !== 'mock' && !hasRealAudio(manifest, wavPath)) {
    console.warn('[bench] WARNING: no real-speech fixture — live vendors need real audio. Run `npm run fixture:speech` first.');
  }
  const provider = await makeProvider(vendor, manifest);
  const { metrics, transcript, usedRealAudio } = await runVendor(provider, manifest, realtime, wavPath);
  const report = summarize(vendor, metrics, transcript);

  const outPath = archive(report, metrics, transcript);
  const wroteRow = upsertResultsRow(report);

  console.log('[bench] report:', JSON.stringify(report, null, 2));
  console.log(
    `[bench] TTFA gross p50/p95 = ${fmt(report.ttfaP50)}/${fmt(report.ttfaP95)} ms · ` +
    `net-of-VAD (−${report.vadSilenceMs} ms) p50/p95 = ${fmt(report.ttfaNetP50)}/${fmt(report.ttfaNetP95)} ms ` +
    `(p50 target ≤500, p95 bar ≤800)`,
  );
  if (report.measuredCost) {
    const mc = report.measuredCost;
    console.log(
      `[bench] MEASURED cost (${mc.model}, ${mc.turnsWithUsage} usage samples): ` +
      `session $${mc.sessionCostUsd.toFixed(4)} over ${mc.sessionDurationMin.toFixed(2)} min ⇒ ` +
      `as-run $${mc.measuredCostPerConvMin.toFixed(3)}/conv-min · 6-min projection $${mc.projected6MinCostPerConvMin.toFixed(3)}/conv-min (band ${mc.band6Min})`,
    );
    console.log(
      `[bench] cache: ${mc.cachedInputPct.toFixed(1)}% of input tokens cached ` +
      `(${mc.cachedInputTokens}/${mc.inputTokensTotal}) ⇒ −${mc.cachingReductionPct.toFixed(1)}% cost vs uncached · ` +
      `audio in/out ${mc.totals.inputAudioTokens}/${mc.totals.outputAudioTokens} tok`,
    );
  }
  console.log(`[bench] raw archived → ${outPath}`);
  console.log(`[bench] real audio streamed: ${usedRealAudio}`);
  console.log(`[bench] RESULTS.md row ${wroteRow ? 'updated' : 'NOT written (mock/unknown vendor — curated table untouched)'}`);
  console.log(`[bench] transcript persisted: ${report.transcriptPersisted} (${transcript.turns.length} turns, ${transcript.toolCalls.length} tool calls)`);
  return report;
}

// Run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
