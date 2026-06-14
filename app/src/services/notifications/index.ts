/**
 * Notification adapter factory (SAU-273, WS3). Resolves the key-gated real vendor
 * when its credentials are configured, else FAILS SOFT to the deterministic mock —
 * so a key-less environment runs the full confirmation + clinic-notice loop with
 * zero credentials and never crashes (mirrors services/calendar).
 *
 *   SMS   → Twilio   (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM)
 *   email → SendGrid (SENDGRID_API_KEY + NOTIFY_EMAIL_FROM)
 *
 * `NOTIFY_PROVIDER=mock` forces the mock even with keys present (useful for the
 * synthetic Phase-1 demo while the HIPAA gate / real BAAs are pending — SAU-272).
 */
import type { NotificationAdapter } from './notification-adapter';
import { MockSmsAdapter, MockEmailAdapter } from './mock-notifier';
import { TwilioSmsAdapter, readTwilioSmsConfig } from './twilio-sms';
import { SendGridEmailAdapter, readSendGridConfig } from './sendgrid-email';

export type { NotificationAdapter, OutboundMessage, DeliveryResult, NotificationChannel } from './notification-adapter';
export { mockOutbox, __resetMockOutbox } from './mock-notifier';

function forceMock(): boolean {
  return (process.env.NOTIFY_PROVIDER ?? 'auto').toLowerCase() === 'mock';
}

export function resolveSmsAdapter(): NotificationAdapter {
  if (!forceMock()) {
    const cfg = readTwilioSmsConfig();
    if (cfg) return new TwilioSmsAdapter(cfg);
  }
  return new MockSmsAdapter();
}

export function resolveEmailAdapter(): NotificationAdapter {
  if (!forceMock()) {
    const cfg = readSendGridConfig();
    if (cfg) return new SendGridEmailAdapter(cfg);
  }
  return new MockEmailAdapter();
}
