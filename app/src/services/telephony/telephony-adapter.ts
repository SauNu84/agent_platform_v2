/**
 * Telephony adapter seam (SAU-270, Phase 1 · WS1) — vendor-neutral phone ingress.
 *
 * Same swap-ability pattern as the calendar seam (SAU-267), the realtime voice
 * vendors (ADR-003), and the chat `ChatResponder`: ONE interface, swappable impls.
 * The inbound-call webhook depends only on this interface, so moving from the
 * fail-soft mock to Twilio (or a SIP trunk, or a future vendor) never touches the
 * route handler or the bridge.
 *
 * Reuses the SAU-253 Integrations "Phone call" provider choice as a config source.
 * The live Twilio adapter is key-gated and the factory FAILS SOFT to the mock when
 * no credentials are present (AC #2: no key ⇒ graceful, clearly-labeled no-op,
 * never a crash). Synthetic callers / internal test numbers ONLY — no real patient
 * audio in this phase (HIPAA gate = sibling SAU-268).
 */

/** Everything the adapter needs to answer one inbound call. */
export interface InboundCallContext {
  /** Vendor call id (Twilio CallSid) when known — for logs/observability. */
  callId?: string;
  /** The dialed number / caller, for routing + audit (synthetic only here). */
  to?: string;
  from?: string;
  /**
   * The scenario the dialed number maps to. The pilot wires ONE number → the
   * clinic agent; multi-number routing is a later phase.
   */
  scenarioSlug: string;
  /**
   * Public wss:// URL of our media bridge server (where the vendor should stream
   * the call audio). Resolved from config; the adapter embeds it in its connect
   * instructions.
   */
  bridgeWsUrl: string;
}

/**
 * The vendor's answer instructions for an inbound call. For Twilio this is TwiML;
 * the field is named generically so a SIP/other vendor can return its own dialect.
 */
export interface InboundCallAnswer {
  /** MIME type of `body` (e.g. `text/xml` for TwiML). */
  contentType: string;
  /** The instruction document handed back to the vendor's webhook. */
  body: string;
  /** True when this is the fail-soft path (no bridge / no creds): a polite no-op. */
  failSoft: boolean;
}

export interface TelephonyAdapter {
  /** Human label for the resolved backend, e.g. "Twilio (inbound)" / "Simulated telephony". */
  readonly label: string;
  /** True when this is the fail-soft mock (no real vendor credentials). */
  readonly simulated: boolean;

  /**
   * Build the vendor instructions that answer an inbound call and bridge its audio
   * to our realtime agent. Pure + synchronous: no network, just config → document,
   * so the webhook stays fast and testable.
   */
  answerInbound(ctx: InboundCallContext): InboundCallAnswer;

  /**
   * Validate an inbound webhook request actually came from the vendor. Twilio signs
   * with `X-Twilio-Signature`; the mock trusts everything. Returns true when the
   * request is trusted (or when validation is intentionally disabled in dev).
   */
  verifyWebhook(req: { url: string; signature: string | null; params: Record<string, string> }): boolean;
}
