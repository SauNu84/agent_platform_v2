/**
 * TwilioTelephonyAdapter (SAU-270) — real Twilio inbound. Key-gated; the factory
 * only selects this when Account SID + auth token are configured. Answers an
 * inbound call with `<Connect><Stream>` TwiML that bridges the call's bidirectional
 * audio to our media-stream WebSocket server, where the bridge wires it to the
 * realtime clinic agent (OpenAI Realtime / Gemini Live).
 *
 * Two graceful degradations keep us off the crash path (AC #2):
 *   - No public bridge URL configured ⇒ fail-soft TwiML (we can't stream anywhere).
 *   - Signature verification disabled (dev/tunnel) ⇒ `verifyWebhook` trusts the
 *     request; with verification on, a bad/absent signature is rejected upstream.
 *
 * Inbound only (the pilot scope). Outbound dialing = a later phase (TCPA).
 */
import type { InboundCallAnswer, InboundCallContext, TelephonyAdapter } from './telephony-adapter';
import { connectStreamTwiml, failSoftTwiml, verifyTwilioSignature } from './twilio-protocol';
import type { TwilioConfig } from './twilio-config';

const NO_BRIDGE_MESSAGE =
  'Thanks for calling. The booking agent is temporarily unavailable. Please try again later. Goodbye.';

export class TwilioTelephonyAdapter implements TelephonyAdapter {
  readonly label: string;
  readonly simulated = false;
  private cfg: TwilioConfig;

  constructor(cfg: TwilioConfig) {
    this.cfg = cfg;
    this.label = `Twilio (inbound${cfg.phoneNumber ? `: ${cfg.phoneNumber}` : ''})`;
  }

  answerInbound(ctx: InboundCallContext): InboundCallAnswer {
    if (!ctx.bridgeWsUrl) {
      return { contentType: 'text/xml', body: failSoftTwiml(NO_BRIDGE_MESSAGE), failSoft: true };
    }
    return { contentType: 'text/xml', body: connectStreamTwiml(ctx.bridgeWsUrl), failSoft: false };
  }

  verifyWebhook(req: { url: string; signature: string | null; params: Record<string, string> }): boolean {
    if (!this.cfg.verifySignatures) return true; // dev/tunnel escape hatch (documented)
    return verifyTwilioSignature({
      authToken: this.cfg.authToken,
      url: req.url,
      params: req.params,
      signature: req.signature,
    });
  }
}
