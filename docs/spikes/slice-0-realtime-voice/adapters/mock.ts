/**
 * Mock realtime adapter (NOT a vendor) — deterministic, in-memory, no network.
 *
 * Purpose: prove the benchmark harness end-to-end OFFLINE. It implements the exact
 * `RealtimeVoiceProvider` contract and emits a realistic, *seeded* event stream
 * (TTFA, mid-turn tool call with continued audio, barge-in stop) so we can verify
 * the metric math, the transcript-persistence path, and the RESULTS/JSON output
 * BEFORE any paid credentials exist. The real vendor adapters are drop-in
 * replacements behind the same interface.
 *
 * Timings are produced by a seeded LCG (no Math.random) so every run is identical
 * and the metric self-test can assert exact bounds.
 */
import {
  RealtimeVoiceProvider, RealtimeSession, CompiledScenario, SessionOptions,
  SessionEvent, Transcript, ToolDefinition, ToolHandler,
} from '../realtime-interface.ts';
import type { FixtureManifest, FixtureTurn } from '../fixtures/fixture.ts';

// ── seeded RNG (mulberry32) ──────────────────────────────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── minimal push-based async event queue ─────────────────────────────────────
class EventQueue {
  private buf: SessionEvent[] = [];
  private waiters: Array<(v: IteratorResult<SessionEvent>) => void> = [];
  private done = false;
  push(e: SessionEvent) {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false });
    else this.buf.push(e);
  }
  close() {
    this.done = true;
    let w; while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: () =>
        new Promise<IteratorResult<SessionEvent>>((resolve) => {
          const e = this.buf.shift();
          if (e) resolve({ value: e, done: false });
          else if (this.done) resolve({ value: undefined as never, done: true });
          else this.waiters.push(resolve);
        }),
    };
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

interface MockTimings {
  vadCommitMs: number;   // server VAD endpoint decision after audio stops
  ttfaBaseMs: number;    // base time-to-first-audio
  ttfaJitterMs: number;  // uniform jitter added to base
  ttfaTailMs: number;    // occasional p95 tail spike
  frameGapMs: number;    // gap between agent audio frames while speaking
  toolLatencyMs: number; // how long the tool handler "runs"
  bargeStopBaseMs: number;
  bargeStopJitterMs: number;
}

const DEFAULT_TIMINGS: MockTimings = {
  vadCommitMs: 60,
  ttfaBaseMs: 120,
  ttfaJitterMs: 60,
  ttfaTailMs: 220,
  frameGapMs: 80,
  toolLatencyMs: 260,
  bargeStopBaseMs: 110,
  bargeStopJitterMs: 60,
};

class MockSession implements RealtimeSession {
  readonly sessionId: string;
  readonly events: EventQueue;
  private handlers = new Map<string, ToolHandler>();
  private rand: () => number;
  private turnIdx = -1;
  private vadTimer: ReturnType<typeof setTimeout> | null = null;
  private speaking: { stop: boolean } | null = null;
  private startedAt = Date.now();
  private tTurns: Transcript['turns'] = [];
  private tCalls: Transcript['toolCalls'] = [];

  constructor(
    private scenario: CompiledScenario,
    private manifest: FixtureManifest,
    private timings: MockTimings,
    seed: number,
  ) {
    this.sessionId = 'mock-' + scenario.id;
    this.events = new EventQueue();
    this.rand = rng(seed);
    this.events.push({ type: 'session.started', at: Date.now() });
  }

  sendAudio(_pcm: Int16Array): void {
    // Server VAD: each frame resets the endpoint timer; fires once after silence.
    if (this.vadTimer) clearTimeout(this.vadTimer);
    this.vadTimer = setTimeout(() => this.commitUtterance(), this.timings.vadCommitMs);
  }

  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    this.handlers.set(def.name, handler);
  }

  interrupt(): void {
    if (!this.speaking) return;
    const ctl = this.speaking;
    this.events.push({ type: 'user.speech.started', at: Date.now() });
    const stop = this.timings.bargeStopBaseMs + Math.floor(this.rand() * this.timings.bargeStopJitterMs);
    setTimeout(() => {
      ctl.stop = true;
      this.events.push({ type: 'agent.interrupted', at: Date.now() });
    }, stop);
  }

  async stop(): Promise<Transcript> {
    if (this.vadTimer) clearTimeout(this.vadTimer);
    const endedAt = Date.now();
    this.events.push({ type: 'session.ended', at: endedAt });
    this.events.close();
    // "Persist" the transcript — in a real adapter this writes the DB row; here we
    // return it (and bench.ts archives it to ./out/) which is the end-to-end proof.
    return { sessionId: this.sessionId, turns: this.tTurns, toolCalls: this.tCalls, startedAt: this.startedAt, endedAt };
  }

  private commitUtterance(): void {
    this.turnIdx += 1;
    const turn = this.manifest.turns[this.turnIdx];
    if (!turn) return;
    void this.runTurn(turn);
  }

  private async runTurn(turn: FixtureTurn): Promise<void> {
    const userText = `user-turn-${turn.index}`;
    this.events.push({ type: 'user.transcript', text: userText, final: true, at: Date.now() });
    this.tTurns.push({ role: 'user', text: userText, at: Date.now() });

    // time-to-first-audio: base + jitter, with an occasional tail to exercise p95
    const tail = this.rand() < 0.1 ? this.timings.ttfaTailMs : 0;
    const ttfa = this.timings.ttfaBaseMs + Math.floor(this.rand() * this.timings.ttfaJitterMs) + tail;
    await delay(ttfa);

    const ctl = { stop: false };
    this.speaking = ctl;
    this.events.push({ type: 'agent.speaking', at: Date.now() });
    this.events.push({ type: 'audio.output', pcm: new Int16Array(320), at: Date.now() }); // first frame ⇒ TTFA

    const agentText = `agent reply to ${turn.index}`;

    if (turn.kind === 'tool') {
      await this.emitFrames(ctl, 2);
      const callId = `call-${turn.index}`;
      const def = this.scenario.tools[0];
      const args = { sku: 'PRO' };
      this.events.push({ type: 'tool.call', id: callId, name: def.name, args, at: Date.now() });
      // Keep talking WHILE the tool runs (this is the property under test).
      const handler = this.handlers.get(def.name);
      const toolPromise = handler ? handler(args) : Promise.resolve({});
      const keepTalking = this.emitFramesFor(ctl, this.timings.toolLatencyMs);
      const [result] = await Promise.all([toolPromise, keepTalking]);
      this.events.push({ type: 'tool.result', id: callId, result, at: Date.now() });
      this.tCalls.push({ name: def.name, args, result, at: Date.now() });
      await this.emitFrames(ctl, 2);
    } else if (turn.kind === 'bargein') {
      // Speak long enough that the harness's mid-playback interrupt() lands.
      await this.emitFramesFor(ctl, 2000);
    } else {
      await this.emitFrames(ctl, 6);
    }

    if (!ctl.stop) {
      this.events.push({ type: 'agent.transcript', text: agentText, final: true, at: Date.now() });
    }
    this.tTurns.push({ role: 'agent', text: agentText, at: Date.now() });
    this.speaking = null;
  }

  private async emitFrames(ctl: { stop: boolean }, n: number): Promise<void> {
    for (let i = 0; i < n && !ctl.stop; i++) {
      await delay(this.timings.frameGapMs);
      if (ctl.stop) return;
      this.events.push({ type: 'audio.output', pcm: new Int16Array(320), at: Date.now() });
    }
  }

  private async emitFramesFor(ctl: { stop: boolean }, durationMs: number): Promise<void> {
    const end = Date.now() + durationMs;
    while (Date.now() < end && !ctl.stop) {
      await delay(this.timings.frameGapMs);
      if (ctl.stop) return;
      this.events.push({ type: 'audio.output', pcm: new Int16Array(320), at: Date.now() });
    }
  }
}

export class MockProvider implements RealtimeVoiceProvider {
  readonly vendor = 'mock' as const;
  constructor(
    private manifest: FixtureManifest,
    private timings: MockTimings = DEFAULT_TIMINGS,
    private seed = 0xc0ffee,
  ) {}
  async startSession(scenario: CompiledScenario, _opts?: SessionOptions): Promise<RealtimeSession> {
    return new MockSession(scenario, this.manifest, this.timings, this.seed);
  }
}

export { DEFAULT_TIMINGS, type MockTimings };
