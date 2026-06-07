/**
 * Mock realtime adapter (NOT a vendor) — deterministic, in-memory, no network.
 *
 * Used to exercise the session service end-to-end OFFLINE: it implements the exact
 * `RealtimeVoiceProvider` contract, self-scripts a short conversation (so a run
 * produces a real transcript without a mic or API key), and reports measured-shaped
 * token usage on stop(). The real vendors (OpenAI Realtime, etc.) are drop-in
 * replacements behind the same interface — that is the swap-ability requirement.
 *
 * Determinism: timings/text are produced from a seeded counter (no Math.random,
 * no Date jitter in the script) so tests can assert exact transcripts/usage.
 */
import {
  RealtimeVoiceProvider, RealtimeSession, CompiledScenario, SessionOptions,
  SessionEvent, Transcript, ToolDefinition, ToolHandler, TurnUsage, SessionUsage,
} from '../realtime-interface';

class Queue {
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
    let w;
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
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

function turnUsage(): TurnUsage {
  return {
    inputTextTokens: 40,
    inputAudioTokens: 600,
    cachedTextTokens: 30,
    cachedAudioTokens: 400,
    outputTextTokens: 20,
    outputAudioTokens: 300,
    totalTokens: 960,
  };
}

export interface MockOptions {
  /** number of agent/user turn pairs to script (default 3) */
  turns?: number;
  /** ms between scripted turns (default 5 — fast for tests) */
  turnGapMs?: number;
}

class MockSession implements RealtimeSession {
  readonly sessionId: string;
  readonly events: Queue;
  private handlers = new Map<string, ToolHandler>();
  private turns: Transcript['turns'] = [];
  private calls: Transcript['toolCalls'] = [];
  private usage: TurnUsage[] = [];
  private startedAt = Date.now();
  private stopped = false;

  constructor(private scenario: CompiledScenario, private opts: Required<MockOptions>) {
    this.sessionId = 'mock-' + scenario.id;
    this.events = new Queue();
    void this.script();
  }

  private async script() {
    this.events.push({ type: 'session.started', at: Date.now() });
    const n = this.opts.turns;
    for (let i = 0; i < n && !this.stopped; i++) {
      await delay(this.opts.turnGapMs);
      if (this.stopped) break;
      const userText = `user turn ${i + 1}`;
      const at1 = Date.now();
      this.events.push({ type: 'user.transcript', text: userText, final: true, at: at1 });
      this.turns.push({ role: 'user', text: userText, at: at1 });

      this.events.push({ type: 'agent.speaking', at: Date.now() });
      this.events.push({ type: 'audio.output', pcm: new Int16Array(320), at: Date.now() });

      // On the first turn, exercise a tool call if the scenario declares one.
      if (i === 0 && this.scenario.tools[0]) {
        const def = this.scenario.tools[0];
        const args = { op: 'demo' };
        const id = 'call-1';
        this.events.push({ type: 'tool.call', id, name: def.name, args, at: Date.now() });
        const result = (await this.handlers.get(def.name)?.(args)) ?? { ok: true };
        this.events.push({ type: 'tool.result', id, result, at: Date.now() });
        this.calls.push({ name: def.name, args, result, at: Date.now() });
      }

      const agentText = `agent reply ${i + 1}`;
      const at2 = Date.now();
      this.events.push({ type: 'agent.transcript', text: agentText, final: true, at: at2 });
      this.turns.push({ role: 'agent', text: agentText, at: at2 });
      this.usage.push(turnUsage());
    }
    // Self-terminate so a server-driven run completes without external input.
    this.events.push({ type: 'session.ended', at: Date.now() });
    this.events.close();
  }

  sendAudio(_pcm: Int16Array): void {
    /* mock self-scripts; audio input is ignored */
  }
  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    this.handlers.set(def.name, handler);
  }
  interrupt(): void {
    this.events.push({ type: 'agent.interrupted', at: Date.now() });
  }

  async stop(): Promise<Transcript> {
    this.stopped = true;
    const endedAt = Date.now();
    return {
      sessionId: this.sessionId,
      turns: this.turns,
      toolCalls: this.calls,
      startedAt: this.startedAt,
      endedAt,
      usage: this.usage.length ? sumUsage(this.usage) : undefined,
      model: 'mock-realtime',
    };
  }
}

function sumUsage(perTurn: TurnUsage[]): SessionUsage {
  const totals: TurnUsage = {
    inputTextTokens: 0, inputAudioTokens: 0, cachedTextTokens: 0,
    cachedAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0, totalTokens: 0,
  };
  for (const t of perTurn) {
    totals.inputTextTokens += t.inputTextTokens;
    totals.inputAudioTokens += t.inputAudioTokens;
    totals.cachedTextTokens += t.cachedTextTokens;
    totals.cachedAudioTokens += t.cachedAudioTokens;
    totals.outputTextTokens += t.outputTextTokens;
    totals.outputAudioTokens += t.outputAudioTokens;
    totals.totalTokens += t.totalTokens;
  }
  return { perTurn, totals };
}

export class MockProvider implements RealtimeVoiceProvider {
  readonly vendor = 'mock' as const;
  private opts: Required<MockOptions>;
  constructor(opts: MockOptions = {}) {
    this.opts = { turns: opts.turns ?? 3, turnGapMs: opts.turnGapMs ?? 5 };
  }
  async startSession(scenario: CompiledScenario, _opts?: SessionOptions): Promise<RealtimeSession> {
    return new MockSession(scenario, this.opts);
  }
}
