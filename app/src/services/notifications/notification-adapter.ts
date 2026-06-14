/**
 * Notification seam (SAU-273, Phase 1 · WS3) — the swappable transport for the
 * booking confirmations (patient SMS + email) and the clinic notification.
 *
 * Mirrors the calendar seam (services/calendar): one narrow interface, a
 * deterministic mock that needs ZERO credentials, and key-gated real vendors
 * (Twilio for SMS, SendGrid for email). The factory (index.ts) FAILS SOFT to the
 * mock when keys are absent, so a key-less environment runs the full close-the-loop
 * flow against a simulated transport and never crashes.
 *
 * CISO content policy (SAU-277): the message BODY carries zero PHI — the patient
 * gets a generic "confirmed" + opaque reference + portal link. The recipient
 * address itself (phone/email) is contact PHI and is NEVER logged in the clear;
 * the delivery log stores only a masked recipient (see clinic-notify).
 */

export type NotificationChannel = 'sms' | 'email';

/** A single outbound message. `subject` is email-only. Body must be PHI-free. */
export interface OutboundMessage {
  /** Recipient address: an E.164 phone for SMS, an email address for email. */
  to: string;
  subject?: string;
  body: string;
}

export interface DeliveryResult {
  ok: boolean;
  /** Vendor message id when delivered (sim id for the mock). */
  providerId?: string;
  /** Set when ok=false; a short, non-PHI reason. */
  error?: string;
  /** true when sent via the deterministic mock transport (no real delivery). */
  simulated: boolean;
}

export interface NotificationAdapter {
  readonly channel: NotificationChannel;
  /** Human label for logs/UI, e.g. "Twilio SMS" / "Simulated SMS". */
  readonly label: string;
  readonly simulated: boolean;
  send(msg: OutboundMessage): Promise<DeliveryResult>;
}
