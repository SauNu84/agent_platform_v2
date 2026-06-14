/**
 * Twilio SMS transport (SAU-273, WS3) — same vendor as the telephony ingress
 * (SAU-270), key-gated and fail-soft.
 *
 * Enabled only when TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM are
 * all present; otherwise the resolver hands back the mock. A send error is caught
 * and returned as { ok:false } (never thrown) so a transport hiccup can NEVER fail
 * a booking that already succeeded — the confirmation is best-effort.
 *
 * Real patient PHI still waits on the HIPAA gate (SAU-272); the message body is
 * PHI-free by policy (SAU-277), so the SMS transport is not a PHI conduit.
 */
import type { NotificationAdapter, OutboundMessage, DeliveryResult } from './notification-adapter';

export interface TwilioSmsConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

/** Read Twilio SMS config from env; null when any required value is missing. */
export function readTwilioSmsConfig(): TwilioSmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_SMS_FROM?.trim();
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

export class TwilioSmsAdapter implements NotificationAdapter {
  readonly channel = 'sms' as const;
  readonly label = 'Twilio SMS';
  readonly simulated = false;

  constructor(private readonly cfg: TwilioSmsConfig) {}

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
    const form = new URLSearchParams({ To: msg.to, From: this.cfg.from, Body: msg.body });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      if (!res.ok) {
        // Twilio error bodies can echo the recipient — surface only the status.
        return { ok: false, error: `twilio sms ${res.status}`, simulated: false };
      }
      const json = (await res.json()) as { sid?: string };
      return { ok: true, providerId: json.sid, simulated: false };
    } catch (e) {
      return { ok: false, error: (e as Error).message, simulated: false };
    }
  }
}
