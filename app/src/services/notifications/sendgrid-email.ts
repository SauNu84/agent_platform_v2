/**
 * SendGrid email transport (SAU-273, WS3) — key-gated and fail-soft.
 *
 * Enabled only when SENDGRID_API_KEY + NOTIFY_EMAIL_FROM are present; otherwise
 * the resolver hands back the mock. (SES is the documented alternative — it slots
 * in as a sibling adapter behind the same interface.) A send error is caught and
 * returned as { ok:false }, never thrown, so it cannot fail a completed booking.
 *
 * Message body is PHI-free by policy (SAU-277): the transport is not a PHI conduit
 * and needs no email-provider BAA.
 */
import type { NotificationAdapter, OutboundMessage, DeliveryResult } from './notification-adapter';

export interface SendGridConfig {
  apiKey: string;
  from: string;
}

export function readSendGridConfig(): SendGridConfig | null {
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  const from = process.env.NOTIFY_EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export class SendGridEmailAdapter implements NotificationAdapter {
  readonly channel = 'email' as const;
  readonly label = 'SendGrid email';
  readonly simulated = false;

  constructor(private readonly cfg: SendGridConfig) {}

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from: { email: this.cfg.from },
          subject: msg.subject ?? 'Notification',
          content: [{ type: 'text/plain', value: msg.body }],
        }),
      });
      if (!res.ok) return { ok: false, error: `sendgrid ${res.status}`, simulated: false };
      // SendGrid returns 202 with an X-Message-Id header and an empty body.
      const providerId = res.headers.get('x-message-id') ?? undefined;
      return { ok: true, providerId, simulated: false };
    } catch (e) {
      return { ok: false, error: (e as Error).message, simulated: false };
    }
  }
}
