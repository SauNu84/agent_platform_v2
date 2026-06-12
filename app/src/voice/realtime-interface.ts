/**
 * Slice-0 Realtime Voice — the HARD BOUNDARY (ADR-003).
 *
 * Every realtime vendor (OpenAI Realtime, Gemini Live, LiveKit, Pipecat) is
 * implemented as ONE `RealtimeVoiceProvider`. The platform and the benchmark
 * depend ONLY on these types — never on a vendor SDK type. Swapping vendors
 * must touch only the adapter that implements this interface.
 *
 * This file is the canonical contract referenced by ADR-003 and ADR-005.
 */

// ── Scenario (compiled from MD per ADR-002; minimal Slice-0 shape) ───────────
export interface CompiledScenario {
  id: string;
  name: string;
  aiInstructions: string;            // persona / system prompt
  voice: { name: string; languageCode: string };
  tools: ToolDefinition[];           // enabled multimodal tools (ADR-005)
  rubric?: unknown;                  // not exercised in Slice-0
}

// ── Tool protocol (ADR-005) ──────────────────────────────────────────────────
export interface ToolDefinition {
  name: string;
  description: string;
  paramsSchema: object;              // JSON Schema for args
  sideEffect: 'ui' | 'server' | 'both';
}
export type ToolHandler = (args: unknown) => Promise<unknown>;

// ── The ordered event stream ─────────────────────────────────────────────────
export type SessionEvent =
  | { type: 'session.started'; at: number }
  | { type: 'audio.output'; pcm: Int16Array; at: number }          // first one ⇒ TTFA
  | { type: 'user.speech.started'; at: number }                    // barge-in trigger
  | { type: 'user.transcript'; text: string; final: boolean; at: number }
  | { type: 'agent.transcript'; text: string; final: boolean; at: number }
  | { type: 'agent.speaking'; at: number }
  | { type: 'agent.interrupted'; at: number }                      // barge-in honored
  | { type: 'tool.call'; id: string; name: string; args: unknown; at: number }
  | { type: 'tool.result'; id: string; result: unknown; at: number }
  | { type: 'ui.effect'; id: string; surface: string; op: string; payload: unknown; at: number }
  | { type: 'tool.rejected'; name: string; reason: string; at: number }
  | { type: 'error'; message: string; at: number }
  | { type: 'session.ended'; at: number };

// ── Measured token usage (per `response.done.usage`) ─────────────────────────
// Vendor-neutral token counts so the bench computes MEASURED cost from real
// tokens (not a rate-card estimate). One entry per model response; the adapter
// sums them into `totals`. Cached counts are the portion of the input that the
// vendor served from its prompt cache (billed at the cached rate).
export interface TurnUsage {
  inputTextTokens: number;
  inputAudioTokens: number;
  cachedTextTokens: number;   // subset of inputTextTokens served from cache
  cachedAudioTokens: number;  // subset of inputAudioTokens served from cache
  outputTextTokens: number;
  outputAudioTokens: number;
  totalTokens: number;
}
export interface SessionUsage {
  perTurn: TurnUsage[];   // one per response.done that carried usage
  totals: TurnUsage;      // element-wise sum of perTurn
}

export interface Transcript {
  sessionId: string;
  turns: Array<{ role: 'user' | 'agent'; text: string; at: number }>;
  toolCalls: Array<{ name: string; args: unknown; result: unknown; at: number }>;
  startedAt: number;
  endedAt: number;
  /** Measured token usage, when the vendor reports it (OpenAI: response.done.usage). */
  usage?: SessionUsage;
  /** Server-reported model id (for auditable rate attribution). */
  model?: string;
}

export interface SessionOptions {
  /** end-of-utterance silence threshold (ms) for VAD/endpointing, where configurable */
  vadSilenceMs?: number;
  /** prefer native speech-to-speech vs cascade (where the vendor supports both) */
  mode?: 's2s' | 'cascade';
  /**
   * Override the realtime model id for this session (SAU-256 tiered router).
   * The platform resolves this from the user's tier via the engine-router seam;
   * the adapter falls back to its configured default when absent. Vendors that
   * don't support model selection ignore it (vendor-neutral).
   */
  model?: string;
}

// ── The session handle ───────────────────────────────────────────────────────
export interface RealtimeSession {
  readonly sessionId: string;
  /** ordered async stream of everything that happens in the session */
  readonly events: AsyncIterable<SessionEvent>;
  /** push mic audio frames in (PCM16) */
  sendAudio(pcm: Int16Array): void;
  /** register a tool the model may call mid-turn (ADR-005) */
  registerTool(def: ToolDefinition, handler: ToolHandler): void;
  /** force barge-in (used by the bench to test interruption) */
  interrupt(): void;
  /** finalize the session and return the persisted transcript */
  stop(): Promise<Transcript>;
}

// ── The vendor adapter contract ──────────────────────────────────────────────
export interface RealtimeVoiceProvider {
  // 'mock' = deterministic in-memory adapter used only to self-validate the bench
  // harness offline (no network, no spend). Real candidates are the others.
  readonly vendor: 'openai' | 'gemini' | 'livekit' | 'pipecat' | 'mock';
  /** the one entry point the whole platform sees */
  startSession(scenario: CompiledScenario, opts?: SessionOptions): Promise<RealtimeSession>;
}
