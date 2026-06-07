/**
 * VoiceAgent — the Slice-0 MVP voice-agent foundation (SAU-194).
 *
 * This is the reusable seam the next person extends. It wires a conversation loop
 * on top of ANY `RealtimeVoiceProvider`:
 *
 *     mic/audio in  →  provider (behind realtime-interface.ts)  →  audio out
 *                       + tools + barge-in + transcript persistence
 *
 * It depends ONLY on `realtime-interface.ts` — never on a vendor SDK. That is the
 * reversibility the CTO required in ADR-003: swapping OpenAI for another vendor is
 * "pass a different provider to the constructor", nothing here changes.
 *
 * Deliberately minimal (the "improve later" is real): no latency tuning, no scale
 * concerns, a stub memory. What it DOES guarantee is a genuinely runnable, end-to-end
 * skeleton with the three properties that matter — audio out, ≥1 tool call, barge-in.
 *
 * ── How to extend ────────────────────────────────────────────────────────────
 *   • Add a tool: add it to the scenario's `tools` and pass a handler in `tools`
 *     to the constructor (see coach/run.ts).
 *   • Swap the vendor: construct with a different RealtimeVoiceProvider.
 *   • Hook a UI / telephony transport: feed frames to `sendAudio()` and consume the
 *     `onEvent` callback (or the raw `session.events` via `start()`'s return).
 */
import type {
  RealtimeVoiceProvider, RealtimeSession, CompiledScenario, SessionOptions,
  SessionEvent, Transcript, ToolHandler,
} from '../realtime-interface.ts';

export interface VoiceAgentOptions extends SessionOptions {
  /** map of tool name → handler; names MUST match the scenario's tool defs. */
  tools?: Record<string, ToolHandler>;
  /** called for EVERY session event in order (audio, transcripts, tool calls…). */
  onEvent?: (e: SessionEvent) => void;
  /** called once when the finished transcript is available (persist hook). */
  onTranscript?: (t: Transcript) => void | Promise<void>;
}

export class VoiceAgent {
  private session: RealtimeSession | null = null;
  private pump: Promise<void> | null = null;

  constructor(
    private readonly provider: RealtimeVoiceProvider,
    private readonly scenario: CompiledScenario,
    private readonly opts: VoiceAgentOptions = {},
  ) {}

  get vendor(): string { return this.provider.vendor; }
  get sessionId(): string | null { return this.session?.sessionId ?? null; }

  /** Open the session, register tools, and start consuming the event stream. */
  async start(): Promise<RealtimeSession> {
    if (this.session) throw new Error('VoiceAgent already started');
    const session = await this.provider.startSession(this.scenario, {
      mode: this.opts.mode,
      vadSilenceMs: this.opts.vadSilenceMs,
    });
    this.session = session;

    // Register handlers for the tools the scenario declared. A declared tool with
    // no handler resolves to {} so the model never hangs waiting on a result.
    for (const def of this.scenario.tools) {
      const handler = this.opts.tools?.[def.name];
      session.registerTool(def, handler ?? (async () => ({})));
    }

    // Drain the ordered event stream in the background and fan it to onEvent.
    const onEvent = this.opts.onEvent;
    this.pump = (async () => {
      for await (const e of session.events) {
        try { onEvent?.(e); } catch (err) { console.error('[voice-agent] onEvent threw:', err); }
      }
    })();

    return session;
  }

  /** Push a PCM16 mic frame to the model. No-op if not started/stopped. */
  sendAudio(pcm: Int16Array): void {
    this.session?.sendAudio(pcm);
  }

  /** Force a barge-in (cut the agent off). Real audio cut-in also triggers VAD. */
  interrupt(): void {
    this.session?.interrupt();
  }

  /** Finalize: stop the session, drain the pump, persist + return the transcript. */
  async stop(): Promise<Transcript> {
    if (!this.session) throw new Error('VoiceAgent not started');
    const transcript = await this.session.stop();
    if (this.pump) { try { await this.pump; } catch { /* stream already closed */ } }
    await this.opts.onTranscript?.(transcript);
    this.session = null;
    this.pump = null;
    return transcript;
  }
}
