/**
 * Call bridge orchestrator (SAU-270) — the vendor-neutral heart of the telephony
 * spike. It wires a PHONE transport (Twilio Media Streams) to a REALTIME transport
 * (OpenAI Realtime / Gemini Live) and runs the action-taking clinic loop:
 *
 *   caller audio ──▶ realtime.appendAudio
 *   realtime audio ─▶ media.sendAudio                (agent speaks back to caller)
 *   realtime VAD speech-started ─▶ media.clear()     (barge-in: stop agent fast)
 *   realtime function-call ─▶ runTool (server-side rules) ─▶ realtime.sendToolResult
 *   call/connection end ─▶ finalize (intake + outcome, reusing SAU-267)
 *
 * Both sides are narrow INTERFACES, so this file has zero network/SDK/`ws`
 * dependency and unit-tests end-to-end with fakes: a simulated inbound call can run
 * intake → check_availability → create_appointment → booked on the mock calendar,
 * exactly the path a real phone call drives (AC #1, verified offline).
 *
 * The clinic RULES still live in the tool executor (SAU-267), never the prompt —
 * the bridge just forwards function calls to it.
 */
import type { Store, SessionTranscript } from '@/db/store';
import type { ScenarioRecord } from '@/domain/scenario';
import { runClinicTool } from '@/services/clinic-booking';
import { finalizeClinicSession, isClinicScenario } from '@/services/clinic-session';

/** The phone side (e.g. Twilio Media Streams). μ-law base64 audio, 8 kHz. */
export interface MediaTransport {
  readonly label: string;
  onAudio(cb: (muLawBase64: string) => void): void;
  onClose(cb: () => void): void;
  /** Stream a chunk of the agent's μ-law audio back to the caller. */
  sendAudio(muLawBase64: string): void;
  /** Flush queued outbound audio (barge-in). */
  clear(): void;
  close(): void;
}

/** The model side (e.g. OpenAI Realtime). Speaks the SAME μ-law @ 8 kHz (g711_ulaw). */
export interface RealtimeTransport {
  readonly vendor: string;
  /** Open the connection + push the session config (instructions, tools, formats). */
  start(): Promise<void>;
  appendAudio(muLawBase64: string): void;
  /** Return a tool result to the model and let it continue the turn. */
  sendToolResult(callId: string, output: unknown): void;
  onAudioDelta(cb: (muLawBase64: string) => void): void;
  /** Caller started speaking (server VAD) → barge-in. */
  onSpeechStarted(cb: () => void): void;
  onFunctionCall(cb: (call: { callId: string; name: string; argsJson: string }) => void): void;
  onTranscript(cb: (turn: { role: 'user' | 'agent'; text: string }) => void): void;
  onError(cb: (message: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface CallBridgeDeps {
  scenario: ScenarioRecord;
  /** Persist intake + outcome at end of call. Defaults to the SAU-267 finalizer. */
  store?: Store;
  userId?: string | null;
  sessionId?: string;
  /** Override the tool executor (tests inject deterministic deps). */
  runTool?: (name: string, argsJson: string) => Promise<unknown>;
  /** Injectable clock for deterministic transcripts. */
  now?: () => number;
  /** Structured log sink (the bridge server passes a console logger). */
  log?: (event: string, meta?: Record<string, unknown>) => void;
}

export interface CallBridge {
  /** Accumulated transcript (turns + tool calls), readable after stop(). */
  readonly transcript: SessionTranscript;
  /** True once the call has been finalized (idempotent). */
  readonly finalized: boolean;
  /** Tear down both transports and finalize once. */
  stop(): Promise<void>;
}

/**
 * Wire a phone transport to a realtime transport and start the realtime session.
 * Returns a handle whose transcript fills in as the call proceeds and that
 * finalizes exactly once (on either side closing, or an explicit stop()).
 */
export async function startCallBridge(
  media: MediaTransport,
  realtime: RealtimeTransport,
  deps: CallBridgeDeps,
): Promise<CallBridge> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const runTool = deps.runTool ?? ((name, argsJson) => runClinicTool(name, safeParse(argsJson)));

  const transcript: SessionTranscript = { turns: [], toolCalls: [] };
  let finalized = false;

  // ── phone → model ──────────────────────────────────────────────────────────
  media.onAudio((muLaw) => realtime.appendAudio(muLaw));

  // ── model → phone ──────────────────────────────────────────────────────────
  realtime.onAudioDelta((muLaw) => media.sendAudio(muLaw));
  realtime.onSpeechStarted(() => {
    // Barge-in: the caller talked over the agent → drop the agent's queued audio.
    media.clear();
    log('barge_in');
  });

  // ── transcripts (best-effort; the outcome is derived from tool calls) ────────
  realtime.onTranscript((turn) => {
    transcript.turns.push({ role: turn.role, text: turn.text, at: now() });
  });

  // ── action-taking: function calls run server-side, result fed back ───────────
  realtime.onFunctionCall(async (call) => {
    const args = safeParse(call.argsJson);
    let result: unknown;
    try {
      result = await runTool(call.name, call.argsJson);
    } catch (e) {
      result = { error: (e as Error).message };
      log('tool_error', { name: call.name, message: (e as Error).message });
    }
    transcript.toolCalls.push({ name: call.name, args, result, at: now() });
    realtime.sendToolResult(call.callId, result);
    log('tool_call', { name: call.name });
  });

  realtime.onError((message) => log('realtime_error', { message }));

  // ── teardown + finalize (exactly once, whichever side ends first) ────────────
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    try {
      media.close();
    } catch {
      /* already closed */
    }
    try {
      realtime.close();
    } catch {
      /* already closed */
    }
    if (deps.store && deps.sessionId && isClinicScenario(deps.scenario)) {
      try {
        const rec = await finalizeClinicSession({
          store: deps.store,
          scenario: deps.scenario,
          sessionId: deps.sessionId,
          userId: deps.userId ?? null,
          transcript,
        });
        log('finalized', { outcome: rec.outcome, eventId: rec.eventId ?? undefined });
      } catch (e) {
        log('finalize_error', { message: (e as Error).message });
      }
    } else {
      log('finalized', { persisted: false });
    }
  };

  media.onClose(finalize);
  realtime.onClose(finalize);

  await realtime.start();
  log('bridge_started', { media: media.label, vendor: realtime.vendor, scenario: deps.scenario.slug });

  return {
    transcript,
    get finalized() {
      return finalized;
    },
    stop: finalize,
  };
}

function safeParse(json: string): unknown {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}
