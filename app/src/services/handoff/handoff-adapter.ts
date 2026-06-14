/**
 * Human-handoff seam (SAU-273, Phase 1 · WS4) — the swappable telephony transport
 * for routing a live caller to a person without dropping them.
 *
 * One narrow interface, a deterministic mock (zero credentials, the fail-soft
 * default), and a key-gated Twilio adapter. The adapter's job is to produce the
 * INSTRUCTION that the telephony bridge (SAU-270) executes on the live call —
 * a TwiML `<Dial>` for a warm transfer, `<Record>` for voicemail, or a queued
 * callback. The bridge wiring lands with the real PSTN demo (SAU-282); this seam
 * lets the escalation logic, persistence, and tests run end-to-end now.
 */

export type HandoffKind = 'warm_transfer' | 'voicemail' | 'callback';

export interface HandoffRequest {
  kind: HandoffKind;
  /** Opaque session/booking reference for the staff queue (no PHI). */
  reference: string;
  /** Why we're escalating (for the staff queue + logs). */
  reason: string;
  /** Caller's number when known (telephony caller-id); contact PHI — never logged raw. */
  callerNumber?: string | null;
}

export interface HandoffResult {
  ok: boolean;
  kind: HandoffKind;
  /** Telephony instruction the bridge should execute (e.g. TwiML), when applicable. */
  instruction?: string;
  /** Vendor id (call/recording/callback id) when the transport returns one. */
  providerId?: string | null;
  simulated: boolean;
  error?: string | null;
}

export interface HandoffAdapter {
  readonly label: string;
  readonly simulated: boolean;
  handle(req: HandoffRequest): Promise<HandoffResult>;
}
