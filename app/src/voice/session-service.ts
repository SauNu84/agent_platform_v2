/**
 * Voice session service — the platform's single entry point to a live session.
 *
 * It depends ONLY on the `RealtimeVoiceProvider` seam (ADR-003), so swapping the
 * vendor never touches this file. Responsibilities:
 *   1. create the `session` row,
 *   2. drive the provider's event stream → persist semantic `session_event` rows,
 *   3. on end, persist the transcript and METER voice minutes + measured tokens
 *      into `voice_usage` (Slice-1 requirement: record usage now; cap enforcement
 *      is Slice 2).
 *
 * `runVoiceSession` is the server-driven path (used by tests with the mock, and a
 * headless OpenAI smoke). The browser live path uses the SAME provider seam
 * client-side and posts its final transcript to `persistClientSession` below — so
 * both paths converge on one persistence + metering routine.
 */
import { toCompiledScenario, type ScenarioRecord } from '@/domain/scenario';
import { resolveKnowledgeContext } from '@/services/knowledge-base';
import type {
  RealtimeVoiceProvider, RealtimeSession, SessionEvent, Transcript, SessionUsage,
} from './realtime-interface';
import { MockProvider } from './adapters/mock';
import { resolveSessionEngine, voiceKbCharBudget, type VoiceTier, type VoiceVendor } from './engine-router';
import type { Store, SessionTranscript, VoiceUsageRecord } from '@/db/store';
import { trackSafe } from '@/services/product-analytics';
import { PRODUCT_EVENTS } from '@/domain/analytics-events';

/** Emit the PII-free engagement event for a completed session (SAU-350). */
async function trackSessionCompleted(
  store: Store,
  ctx: { sessionId: string; scenarioId: string; userId: string | null; clinicId: string | null; vendor: string; transcript: SessionTranscript },
): Promise<void> {
  await trackSafe(store, {
    event: PRODUCT_EVENTS.SESSION_COMPLETED,
    surface: 'voice',
    actorId: ctx.userId,
    tenantId: ctx.clinicId,
    sessionId: ctx.sessionId,
    scenarioId: ctx.scenarioId,
    props: { vendor: ctx.vendor, turns: ctx.transcript.turns.length, tool_calls: ctx.transcript.toolCalls.length },
  });
}

export type Vendor = 'openai' | 'gemini' | 'mock';

/**
 * Resolve the realtime vendor adapter behind the stable interface (ADR-003).
 * Real vendors are key-gated and FAIL SOFT to the mock adapter when their key is
 * absent — a key-less deploy never crashes a Join (SAU-258 AC).
 */
export async function getProvider(vendor: Vendor): Promise<RealtimeVoiceProvider> {
  if (vendor === 'mock') return new MockProvider();
  if (vendor === 'gemini') {
    if (!process.env.GEMINI_API_KEY) return new MockProvider(); // no key ⇒ graceful mock
    const { GeminiRealtimeProvider } = await import('./adapters/gemini');
    return new GeminiRealtimeProvider();
  }
  if (!process.env.OPENAI_API_KEY) return new MockProvider(); // no key ⇒ graceful mock
  // Lazy import keeps `ws` server-only and out of any client bundle.
  const { OpenAIRealtimeProvider } = await import('./adapters/openai');
  return new OpenAIRealtimeProvider();
}

export function defaultVendor(): Vendor {
  const v = (process.env.REALTIME_VENDOR ?? 'openai').toLowerCase();
  if (v === 'mock') return 'mock';
  if (v === 'gemini') return 'gemini';
  return 'openai';
}

/**
 * Map an engine's vendor to the realtime transport to actually use for a
 * client-driven (browser-produced) session, falling back to the mock vendor when
 * that vendor's API key is absent so persistence never fails (SAU-258).
 */
export function clientVendorForEngine(vendor: VoiceVendor): Vendor {
  if (vendor === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : 'mock';
  if (vendor === 'openai') return process.env.OPENAI_API_KEY ? 'openai' : 'mock';
  return 'mock';
}

/** A safety timeout that does NOT keep the process/event loop alive once the
 *  session resolves first (unref'd). */
function safetyTimeout(ms: number): Promise<'timeout'> {
  return new Promise<'timeout'>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Which events carry semantic value worth persisting (raw audio frames are not). */
function eventToRow(ev: SessionEvent): { type: string; payload: Record<string, unknown> } | null {
  switch (ev.type) {
    case 'audio.output':
      return null; // never persist PCM frames; first-audio timing tracked separately
    case 'user.transcript':
    case 'agent.transcript':
      return { type: ev.type, payload: { text: ev.text, final: ev.final } };
    case 'tool.call':
      return { type: ev.type, payload: { id: ev.id, name: ev.name, args: ev.args } };
    case 'tool.result':
      return { type: ev.type, payload: { id: ev.id, result: ev.result } };
    case 'ui.effect':
      return { type: ev.type, payload: { id: ev.id, surface: ev.surface, op: ev.op, payload: ev.payload } };
    case 'tool.rejected':
      return { type: ev.type, payload: { name: ev.name, reason: ev.reason } };
    case 'error':
      return { type: ev.type, payload: { message: ev.message } };
    default:
      return { type: ev.type, payload: {} };
  }
}

function usageToRecord(
  base: {
    sessionId: string; userId: string | null; scenarioId: string; vendor: string;
    tier: VoiceTier; engine: string;
  },
  transcript: Transcript,
): VoiceUsageRecord {
  const durationMs = Math.max(0, transcript.endedAt - transcript.startedAt);
  const u: SessionUsage['totals'] | undefined = transcript.usage?.totals;
  return {
    ...base,
    model: transcript.model ?? null,
    durationMs,
    voiceMinutes: Number((durationMs / 60000).toFixed(4)),
    inputTextTokens: u?.inputTextTokens ?? 0,
    inputAudioTokens: u?.inputAudioTokens ?? 0,
    cachedTextTokens: u?.cachedTextTokens ?? 0,
    cachedAudioTokens: u?.cachedAudioTokens ?? 0,
    outputTextTokens: u?.outputTextTokens ?? 0,
    outputAudioTokens: u?.outputAudioTokens ?? 0,
    totalTokens: u?.totalTokens ?? 0,
  };
}

function toSessionTranscript(t: Transcript): SessionTranscript {
  return { turns: t.turns, toolCalls: t.toolCalls };
}

export interface RunVoiceSessionOptions {
  store: Store;
  scenario: ScenarioRecord;
  vendor: Vendor;
  /** voice tier (SAU-256): selects the engine + the metered tier. Default 'free'. */
  tier?: VoiceTier;
  /** scenario's chosen engine id (SAU-258, metadata._model); router gates by tier. */
  modelId?: string | null;
  userId?: string | null;
  /** owning clinic/org for multi-clinic PHI scoping (SAU-275); null = platform. */
  clinicId?: string | null;
  /** tag the session as coach-driven / in-course (Slice 3 compositions) */
  coachId?: string | null;
  courseId?: string | null;
  /** override agent instructions (e.g. Coach memory injection); defaults to the scenario's */
  instructions?: string;
  /** safety cap so a hung session can't block forever (default 30s) */
  maxMs?: number;
  /** optional driver to push mic audio into the session (used for the OpenAI path) */
  drive?: (session: RealtimeSession) => Promise<void>;
}

export interface VoiceSessionResult {
  sessionId: string;
  transcript: SessionTranscript;
  usage: VoiceUsageRecord;
  firstAudioMs: number | null;
}

/**
 * Server-driven run: start a session, persist its events + transcript, meter usage.
 * Returns once the session ends (or `maxMs` elapses).
 */
export async function runVoiceSession(opts: RunVoiceSessionOptions): Promise<VoiceSessionResult> {
  const { store, scenario, vendor, tier = 'free', modelId = null, userId = null, clinicId = null, coachId = null, courseId = null, instructions, maxMs = 30000, drive } = opts;
  const provider = await getProvider(vendor);
  // Tiered router (SAU-256/258): resolve the engine from the scenario's chosen
  // model + the viewer's tier (tier gating downgrades premium → cost for free).
  const engine = resolveSessionEngine({ modelId, tier });
  // Fold any linked Knowledge Base (SAU-243) into the voice agent's instructions,
  // bounded by the tighter VOICE budget (cost lever #2) for a small, cacheable prefix.
  const kb = await resolveKnowledgeContext(store, scenario.id, voiceKbCharBudget());
  const compiled = toCompiledScenario(scenario, { knowledgeBaseText: kb.text });
  if (instructions) compiled.aiInstructions = instructions;
  const sessionRow = await store.createSession({ scenarioId: scenario.id, userId, clinicId, vendor, coachId, courseId });

  const session = await provider.startSession(compiled, { model: engine.model });
  // Register no-op UI tool handlers so a tool call mid-session resolves + is logged.
  for (const tool of compiled.tools) {
    session.registerTool(tool, async () => ({ ack: true, tool: tool.name }));
  }

  let firstAudioAt: number | null = null;
  const startWall = Date.now();
  const consume = (async () => {
    for await (const ev of session.events) {
      if (ev.type === 'audio.output' && firstAudioAt === null) firstAudioAt = ev.at;
      const row = eventToRow(ev);
      if (row) await store.appendSessionEvent({ sessionId: sessionRow.id, ts: ev.at, type: row.type, payload: row.payload });
      if (ev.type === 'session.ended') break;
    }
  })();

  if (drive) await drive(session);
  await Promise.race([consume, safetyTimeout(maxMs)]);

  const transcript = await session.stop();
  await consume.catch(() => undefined);

  const sessionTranscript = toSessionTranscript(transcript);
  await store.completeSession(sessionRow.id, {
    status: 'completed',
    startedAt: transcript.startedAt,
    endedAt: transcript.endedAt,
    transcript: sessionTranscript,
  });

  const usage = usageToRecord(
    { sessionId: sessionRow.id, userId, scenarioId: scenario.id, vendor, tier, engine: engine.model },
    transcript,
  );
  await store.recordVoiceUsage(usage);
  await trackSessionCompleted(store, { sessionId: sessionRow.id, scenarioId: scenario.id, userId, clinicId, vendor, transcript: sessionTranscript });

  return {
    sessionId: sessionRow.id,
    transcript: sessionTranscript,
    usage,
    firstAudioMs: firstAudioAt !== null ? firstAudioAt - startWall : null,
  };
}

/**
 * Browser live path: the client ran the session via the same provider seam and
 * posts back its final transcript + measured usage. We persist + meter identically.
 */
export async function persistClientSession(opts: {
  store: Store;
  scenario: ScenarioRecord;
  vendor: Vendor;
  /** voice tier (SAU-256): the engine the browser ran + the metered tier. Default 'free'. */
  tier?: VoiceTier;
  /** scenario's chosen engine id (SAU-258, metadata._model); router gates by tier. */
  modelId?: string | null;
  userId?: string | null;
  /** owning clinic/org for multi-clinic PHI scoping (SAU-275); null = platform. */
  clinicId?: string | null;
  coachId?: string | null;
  courseId?: string | null;
  transcript: Transcript;
}): Promise<VoiceSessionResult> {
  const { store, scenario, vendor, tier = 'free', modelId = null, userId = null, clinicId = null, coachId = null, courseId = null, transcript } = opts;
  const engine = resolveSessionEngine({ modelId, tier });
  const sessionRow = await store.createSession({ scenarioId: scenario.id, userId, clinicId, vendor, coachId, courseId });
  const sessionTranscript = toSessionTranscript(transcript);
  // Persist transcript turns/tool-calls as events for the Sessions tab + Analyst.
  for (const turn of transcript.turns) {
    await store.appendSessionEvent({ sessionId: sessionRow.id, ts: turn.at, type: `${turn.role}.transcript`, payload: { text: turn.text, final: true } });
  }
  for (const call of transcript.toolCalls) {
    await store.appendSessionEvent({ sessionId: sessionRow.id, ts: call.at, type: 'tool.call', payload: { name: call.name, args: call.args, result: call.result } });
  }
  await store.completeSession(sessionRow.id, { status: 'completed', startedAt: transcript.startedAt, endedAt: transcript.endedAt, transcript: sessionTranscript });
  const usage = usageToRecord({ sessionId: sessionRow.id, userId, scenarioId: scenario.id, vendor, tier, engine: engine.model }, transcript);
  await store.recordVoiceUsage(usage);
  await trackSessionCompleted(store, { sessionId: sessionRow.id, scenarioId: scenario.id, userId, clinicId, vendor, transcript: sessionTranscript });
  return { sessionId: sessionRow.id, transcript: sessionTranscript, usage, firstAudioMs: null };
}
