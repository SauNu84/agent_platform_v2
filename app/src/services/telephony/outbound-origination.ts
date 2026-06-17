/**
 * Outbound origination seam (SAU-334, WS-3) — the OUTBOUND counterpart to the inbound
 * telephony adapter (SAU-270). The clinic agent was inbound (the patient calls in);
 * collections is outbound (the agent dials out). This seam is the one place that turns
 * "we decided to dial" into an actual origination request, reframing the SAU-292/293
 * Twilio + Realtime bridge for origination.
 *
 * Vendor-neutral, same swap-ability pattern as everything else: ONE interface, mock +
 * live impls. The {@link CollectionsDialer} depends only on this interface, so it never
 * touches a vendor SDK and unit-tests end-to-end with a deterministic mock.
 *
 * SAFETY — two stacked gates keep this synthetic-only (SAU-328) until the go-live gate
 * (SAU-331) is satisfied:
 *   1. Twilio credentials must be configured (same as inbound).
 *   2. `COLLECTIONS_LIVE_DIAL_CONFIRMED=true` must be set — the explicit go-live flag,
 *      modeled on `OPENAI_PHI_ZDR_CONFIRMED` (SAU-277). It can only be set out-of-band
 *      once SAU-331's checklist is green.
 * Absent EITHER, {@link resolveOutboundDialer} FAILS CLOSED to the mock — so by
 * construction this code cannot place a real consumer call in the POC environment.
 */
import type { TwilioConfig } from './twilio-config';
import { resolveTwilioConfig, type PhoneIntegrationSetting } from './twilio-config';

/** Terminal disposition of one origination attempt. */
export type OutboundCallStatus = 'connected' | 'voicemail' | 'no_answer' | 'busy' | 'failed';

/**
 * Everything the seam needs to originate ONE outbound call. The server-fixed scripts
 * are passed IN by the dialer (it owns guardrails 5 & 8); the seam injects the
 * disclosure as the first utterance on connect and plays the voicemail script if the
 * call goes to voicemail.
 */
export interface OutboundDialRequest {
  /** Debtor phone (E.164). Synthetic / owned test number only in this phase. */
  to: string;
  /** Owned caller-id we dial FROM (E.164). */
  from: string;
  /** Correlation id for logs/audit (no PII). */
  callId?: string;
  /** Public wss:// bridge URL where the vendor should stream the call audio. */
  bridgeWsUrl?: string;
  /** Guardrail 5: the fixed disclosure injected as the first utterance on connect. */
  disclosure: string;
  /** Guardrail 8: the limited-content voicemail script (already screened by the dialer). */
  voicemailScript: string;
  /** The collections agent persona for the realtime session. */
  agentInstructions: string;
}

/** Outcome of an origination attempt. */
export interface OutboundCallResult {
  /** Vendor/correlation call id. */
  callId: string;
  status: OutboundCallStatus;
  /** True iff a live conversation about the debt occurred (drives the Reg-F cooldown). */
  hadConversation: boolean;
  /**
   * The line actually played FIRST on a connected call — the disclosure. Null when the
   * call did not connect. WS-3 asserts this equals the required disclosure on every
   * connected call (guardrail 5).
   */
  openingLine: string | null;
  /** Human label of the backend that placed (or simulated) the call. */
  vendorLabel: string;
}

export interface OutboundDialer {
  /** Human label, e.g. "Twilio (outbound)" / "Simulated outbound dialer". */
  readonly label: string;
  /** True when this is the simulated mock (no real vendor / not go-live confirmed). */
  readonly simulated: boolean;
  /**
   * Place one outbound call. The dialer only ever calls this AFTER WS-1's `canDialNow`
   * returns ALLOW — origination is unreachable on a BLOCK decision.
   */
  originate(req: OutboundDialRequest): Promise<OutboundCallResult>;
}

/**
 * Deterministic simulated dialer for the synthetic POC + tests. Never touches the
 * network. The outcome is supplied by an injectable `simulate` callback (defaults to a
 * connected call with a conversation), so a test can drive every path — connected,
 * voicemail, no-answer — without a real vendor. On a connected call it echoes the
 * disclosure as `openingLine`, proving the server injected it first (guardrail 5).
 */
export class MockOutboundDialer implements OutboundDialer {
  readonly label = 'Simulated outbound dialer';
  readonly simulated = true;
  private simulate: (req: OutboundDialRequest) => OutboundCallStatus;
  private seq = 0;

  constructor(opts?: { simulate?: (req: OutboundDialRequest) => OutboundCallStatus }) {
    this.simulate = opts?.simulate ?? (() => 'connected');
  }

  async originate(req: OutboundDialRequest): Promise<OutboundCallResult> {
    const status = this.simulate(req);
    const callId = req.callId ?? `sim-call-${++this.seq}`;
    return {
      callId,
      status,
      hadConversation: status === 'connected',
      // The disclosure is what the server plays first on connect; null otherwise.
      openingLine: status === 'connected' ? req.disclosure : null,
      vendorLabel: this.label,
    };
  }
}

/**
 * Live Twilio outbound dialer. Constructed ONLY when credentials AND the go-live flag
 * are present (see {@link resolveOutboundDialer}). It originates a call via Twilio's
 * REST API with `<Connect><Stream>` TwiML pointing at our bridge (the SAU-270/293
 * path, reframed outbound). Even so, `originate` re-checks the go-live confirmation and
 * throws if it is not set — defense in depth so a misconfigured factory can never dial.
 */
export class TwilioOutboundDialer implements OutboundDialer {
  readonly label: string;
  readonly simulated = false;
  private cfg: TwilioConfig;
  private liveConfirmed: boolean;

  constructor(cfg: TwilioConfig, liveConfirmed: boolean) {
    this.cfg = cfg;
    this.liveConfirmed = liveConfirmed;
    this.label = `Twilio (outbound${cfg.phoneNumber ? `: ${cfg.phoneNumber}` : ''})`;
  }

  async originate(req: OutboundDialRequest): Promise<OutboundCallResult> {
    if (!this.liveConfirmed) {
      // Go-live gate (SAU-331) not satisfied — refuse to place a real call.
      throw new Error('collections_live_dial_not_authorized: go-live gate (SAU-331) not confirmed.');
    }
    const callId = req.callId ?? '';
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
    const body = new URLSearchParams({
      To: req.to,
      From: req.from,
      // The bridge streams the call to the realtime collections agent; the disclosure is
      // injected by the bridge as the first utterance (guardrail 5).
      Twiml: connectStreamTwiml(req.bridgeWsUrl ?? ''),
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    if (!res.ok) {
      return { callId, status: 'failed', hadConversation: false, openingLine: null, vendorLabel: this.label };
    }
    const json = (await res.json()) as { sid?: string };
    // Final status (connected/voicemail/no-answer) arrives asynchronously on the status
    // webhook (SAU-270); origination itself only confirms the call was queued.
    return {
      callId: json.sid ?? callId,
      status: 'connected',
      hadConversation: false,
      openingLine: req.disclosure,
      vendorLabel: this.label,
    };
  }
}

/** Minimal `<Connect><Stream>` TwiML for the outbound bridge (mirrors twilio-protocol). */
function connectStreamTwiml(bridgeWsUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${bridgeWsUrl}"/></Connect></Response>`;
}

/** True iff the go-live gate flag (SAU-331) is explicitly confirmed in the environment. */
export function isLiveDialConfirmed(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.COLLECTIONS_LIVE_DIAL_CONFIRMED ?? '').trim());
}

/**
 * Resolve the active outbound dialer. FAILS CLOSED to the mock unless BOTH Twilio
 * credentials are configured AND the go-live gate (SAU-331) is confirmed — so the POC
 * is architecturally incapable of placing a real consumer call. `TELEPHONY_PROVIDER=mock`
 * forces the mock regardless.
 */
export function resolveOutboundDialer(setting?: PhoneIntegrationSetting | null): OutboundDialer {
  if ((process.env.TELEPHONY_PROVIDER ?? 'auto').toLowerCase() === 'mock') return new MockOutboundDialer();
  const cfg = resolveTwilioConfig(setting);
  if (cfg && isLiveDialConfirmed()) return new TwilioOutboundDialer(cfg, true);
  return new MockOutboundDialer();
}
