/**
 * MockTelephonyAdapter (SAU-270) — the fail-soft default. Selected when no Twilio
 * credentials (or no public bridge URL) are present, so a key-less environment
 * answers the webhook with a polite, clearly-labeled no-op instead of crashing
 * (AC #2). It never bridges audio — there's no vendor behind it.
 */
import type { InboundCallAnswer, InboundCallContext, TelephonyAdapter } from './telephony-adapter';
import { failSoftTwiml } from './twilio-protocol';

const FAIL_SOFT_MESSAGE =
  'Thanks for calling. The clinic booking agent is not connected in this environment yet. ' +
  'This is a simulated telephony endpoint. Goodbye.';

export class MockTelephonyAdapter implements TelephonyAdapter {
  readonly label = 'Simulated telephony (no vendor)';
  readonly simulated = true;

  answerInbound(_ctx: InboundCallContext): InboundCallAnswer {
    return { contentType: 'text/xml', body: failSoftTwiml(FAIL_SOFT_MESSAGE), failSoft: true };
  }

  /** Nothing to verify without a vendor; trust the (synthetic/dev) request. */
  verifyWebhook(_req: { url: string; signature: string | null; params: Record<string, string> }): boolean {
    return true;
  }
}
