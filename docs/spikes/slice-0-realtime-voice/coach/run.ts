/**
 * Coach foundation — runnable entry point (SAU-194).
 *
 *   tsx coach/run.ts --vendor mock              # offline, deterministic, no spend
 *   tsx coach/run.ts --vendor openai --realtime # LIVE OpenAI Realtime (needs OPENAI_API_KEY)
 *
 * This is the "documented entry point so the next person can extend it" the issue
 * asks for. It does the smallest real thing: builds a `VoiceAgent` on the chosen
 * provider (OpenAI behind the interface, or the offline mock), drives the SYNTHETIC
 * coach fixture through it, and prints the conversation as it happens — demonstrating
 * audio out, a `saveReflection` tool call, and a barge-in end-to-end. The finished
 * transcript is persisted via the minimal `CoachMemory` stub.
 *
 * Everything vendor-specific lives in the adapter behind `realtime-interface.ts`;
 * this file only ever touches the interface + the foundation. Swapping vendors =
 * changing the `--vendor` switch.
 *
 * PRIVACY (ADR-003): the driver audio is macOS-`say` synthetic speech, never real
 * user PII. Keep it that way until the OpenAI DPA / no-train / retention gate closes.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RealtimeVoiceProvider, SessionEvent } from '../realtime-interface.ts';
import { loadManifest, readWavPcm, sliceMs, hasRealAudio, type FixtureManifest, type FixtureTurn } from '../fixtures/fixture.ts';
import { loadDotEnv } from '../load-env.ts';
import { VoiceAgent } from './voice-agent.ts';
import { COACH_SCENARIO } from './coach-scenario.ts';
import { CoachMemory } from './memory.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAD_FLUSH_MS = 800;            // trailing silence so server VAD commits the turn
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Minimal event synchronizer: records every event the agent emits and lets the
 * driver await turn boundaries (first audio, tool result, interruption). Without
 * this the driver races the provider — the mock advances turns on its own VAD
 * timer, so a fire-and-forget loop mis-attributes the barge-in. Same pattern the
 * bench uses; kept tiny here.
 */
class EventSync {
  readonly all: SessionEvent[] = [];
  private waiters: Array<() => void> = [];
  record(e: SessionEvent): void { this.all.push(e); const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  async waitFor(pred: (e: SessionEvent) => boolean, timeoutMs: number): Promise<SessionEvent | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.all.find(pred);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now())));
        this.waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
  }
}

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function makeProvider(vendor: string, manifest: FixtureManifest): Promise<RealtimeVoiceProvider> {
  switch (vendor) {
    case 'mock': {
      const { MockProvider } = await import('../adapters/mock.ts');
      return new MockProvider(manifest);
    }
    case 'openai': {
      const { OpenAIRealtimeProvider } = await import('../adapters/openai.ts');
      return new OpenAIRealtimeProvider();
    }
    default:
      throw new Error(`unknown vendor '${vendor}' (foundation ships openai|mock)`);
  }
}

/** Stream a PCM buffer (or sized silence) as frameMs chunks; pace at 1x when realtime. */
async function streamAudio(
  agent: VoiceAgent, manifest: FixtureManifest, pcm: Int16Array | null, fallbackMs: number, realtime: boolean,
): Promise<void> {
  const samplesPerFrame = Math.floor((manifest.sampleRate * manifest.frameMs) / 1000);
  if (pcm) {
    for (let o = 0; o < pcm.length; o += samplesPerFrame) {
      agent.sendAudio(pcm.subarray(o, Math.min(pcm.length, o + samplesPerFrame)));
      if (realtime) await sleep(manifest.frameMs);
    }
  } else {
    const frames = Math.max(1, Math.floor(fallbackMs / manifest.frameMs));
    for (let f = 0; f < frames; f++) {
      agent.sendAudio(new Int16Array(samplesPerFrame));
      if (realtime) await sleep(manifest.frameMs);
    }
  }
}

async function main(): Promise<void> {
  const loaded = loadDotEnv(HERE.replace(/\/coach$/, '')); // .env lives in the spike root
  if (loaded.length) console.log(`[coach] loaded from .env: ${loaded.join(', ')}`);

  const vendor = getArg('vendor') ?? 'mock';
  const realtime = process.argv.includes('--realtime');

  // The foundation ships its own short synthetic coach fixture; fall back to the
  // bench fixture only if the coach one wasn't generated.
  const coachManifest = join(HERE, 'coach-manifest.json');
  const manifestPath = existsSync(coachManifest) ? coachManifest : join(HERE, '..', 'fixtures', 'manifest.json');
  const manifest = loadManifest(manifestPath);
  const wavPath = join(dirname(manifestPath), manifest.wav);
  const realAudio = hasRealAudio(manifest, wavPath);
  const wav = realAudio ? readWavPcm(wavPath) : null;

  console.log(`[coach] vendor=${vendor} realtime=${realtime} turns=${manifest.turns.length} audio=${realAudio ? manifest.wav + ' (synthetic)' : 'silence'}`);
  if (vendor === 'openai' && !realAudio) {
    console.warn('[coach] WARNING: no synthetic speech fixture — run `tsx coach/make-coach-fixture.ts` first (macOS).');
  }

  // Namespace the stub store per vendor so an offline mock run's placeholder
  // reflections don't bleed into a live run's `recallReflections`.
  const memory = new CoachMemory(`synthetic-${vendor}`);
  const provider = await makeProvider(vendor, manifest);

  // The conversation log — printed live so a human can SEE it work end-to-end.
  const seen = { audio: false, tool: false, bargeIn: false };
  const sync = new EventSync();
  const onEvent = (e: SessionEvent) => {
    sync.record(e);
    switch (e.type) {
      case 'audio.output': if (!seen.audio) { seen.audio = true; console.log('  🔊 first audio frame (TTFA)'); } break;
      case 'user.transcript': if (e.final) console.log(`  🧑 user: ${e.text}`); break;
      case 'agent.transcript': if (e.final) console.log(`  🤖 coach: ${e.text}`); break;
      case 'tool.call': seen.tool = true; console.log(`  🛠️  tool.call ${e.name}(${JSON.stringify(e.args)})`); break;
      case 'tool.result': console.log(`  ✅ tool.result ${JSON.stringify(e.result)}`); break;
      case 'agent.interrupted': seen.bargeIn = true; console.log('  ✋ barge-in honored (agent interrupted)'); break;
      case 'error': console.error(`  ⚠️  error: ${e.message}`); break;
    }
  };

  const agent = new VoiceAgent(provider, COACH_SCENARIO, {
    mode: 's2s',
    onEvent,
    onTranscript: (t) => { memory.saveTranscript(t); },
    tools: {
      saveReflection: async (args: any) => {
        const insight = String(args?.insight ?? 'reflection');
        const r = memory.saveReflection(insight, args?.tag);
        return { saved: true, at: r.at };
      },
      recallReflections: async (args: any) => {
        const items = memory.recallReflections(Number(args?.limit) || 3);
        return { reflections: items };
      },
    },
  });

  await agent.start();

  // Drive the synthetic fixture, turn by turn (the conversation loop).
  for (const turn of manifest.turns as FixtureTurn[]) {
    const user = wav && turn.audioDurationMs != null
      ? sliceMs(wav.pcm, wav.sampleRate, turn.audioStartMs!, turn.audioDurationMs)
      : null;
    await streamAudio(agent, manifest, user, turn.userMs, realtime);
    const utteranceEnd = Date.now();
    await streamAudio(agent, manifest, null, VAD_FLUSH_MS, realtime); // flush → VAD commits

    // Wait for THIS turn's first audio frame so we synchronize with the provider.
    await sync.waitFor((e) => e.type === 'audio.output' && e.at >= utteranceEnd, 6000);

    if (turn.kind === 'bargein') {
      await sleep(turn.bargeInAfterMs ?? 500);
      if (wav && turn.bargeDurationMs != null) {
        const cut = sliceMs(wav.pcm, wav.sampleRate, turn.bargeStartMs!, turn.bargeDurationMs);
        await streamAudio(agent, manifest, cut, 0, realtime);
      }
      agent.interrupt();
      await sync.waitFor((e) => e.type === 'agent.interrupted' && e.at >= utteranceEnd, 3000);
    } else if (turn.kind === 'tool') {
      await sync.waitFor((e) => e.type === 'tool.result' && e.at >= utteranceEnd, 6000);
    }
    await sleep(realtime ? 1200 : 250); // let trailing audio drain before the next turn
  }
  await sleep(realtime ? 1500 : 300);

  const transcript = await agent.stop();
  console.log(
    `\n[coach] done — vendor=${agent.vendor} session=${transcript.sessionId} ` +
    `turns=${transcript.turns.length} toolCalls=${transcript.toolCalls.length}`,
  );
  console.log(
    `[coach] demonstrated:  audio-out=${seen.audio ? '✅' : '❌'}  ` +
    `tool-call=${seen.tool ? '✅' : '❌'}  barge-in=${seen.bargeIn ? '✅' : '❌'}`,
  );
  console.log(`[coach] transcript persisted via CoachMemory stub (coach/.sessions/synthetic-${vendor}.json)`);

  // Make the demonstration self-checking so the entry point is a real proof, not a log.
  if (!seen.audio || !seen.tool || !seen.bargeIn) {
    throw new Error('foundation demo did NOT exercise all three of {audio, tool, barge-in} — see log above');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
