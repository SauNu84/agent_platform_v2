/**
 * Booking-confirmation + clinic-notice dispatch (SAU-273, Phase 1 · WS3).
 *
 * On a SUCCESSFUL booking this closes the loop: it sends the patient a PHI-free
 * SMS + email (SAU-277 templates) and notifies the clinic, through the key-gated /
 * fail-soft notification seam. Every send is logged (channel, audience, masked
 * recipient, status) so the caller can persist a delivery record.
 *
 * Hard guarantees:
 *   • PHI-leak guard is FAIL-CLOSED — if a template ever renders a patient
 *     identifier into the body, we refuse to send that message (status 'blocked')
 *     rather than leak it through SMS/email. `findPhiLeaks` is the check.
 *   • Recipient addresses (phone/email) are contact PHI: only a MASKED form is
 *     ever returned/logged, never the raw value.
 *   • Best-effort: a transport failure returns a 'failed' delivery; it never throws,
 *     so a completed booking is never undone by a confirmation problem.
 */
import {
  buildSmsConfirmation,
  buildEmailConfirmation,
  findPhiLeaks,
  type BookingPhi,
} from '@/services/clinic-confirmation';
import { resolveSmsAdapter, resolveEmailAdapter } from '@/services/notifications';
import type { OutboundMessage } from '@/services/notifications';

export type NotifyAudience = 'patient' | 'clinic';
export type NotifyStatus = 'sent' | 'failed' | 'blocked' | 'skipped';

export interface NotificationDelivery {
  channel: 'sms' | 'email';
  audience: NotifyAudience;
  /** Masked recipient — never the raw phone/email (contact PHI). */
  recipientMasked: string;
  status: NotifyStatus;
  providerId?: string | null;
  simulated: boolean;
  error?: string | null;
}

export interface DispatchContacts {
  /** Patient's E.164 phone, when captured during the call. */
  patientPhone?: string | null;
  /** Patient's email, when captured during the call. */
  patientEmail?: string | null;
}

export interface DispatchBookingInput {
  /** Opaque booking reference (the calendar event id). MUST NOT encode PHI. */
  reference: string;
  clinicName?: string | null;
  contacts: DispatchContacts;
  /** The PHI handled by this booking — used ONLY by the fail-closed leak guard. */
  phi: BookingPhi;
}

/** Mask a phone/email so a delivery log identifies the channel without storing PHI. */
export function maskRecipient(value: string): string {
  const v = value.trim();
  if (v.includes('@')) {
    const [local, domain] = v.split('@');
    const head = local.slice(0, 1) || '*';
    return `${head}***@${domain ?? ''}`;
  }
  const digits = v.replace(/[^\d]/g, '');
  const last4 = digits.slice(-4).padStart(4, '*');
  return `***-***-${last4}`;
}

/** Secure patient portal base — where every clinical/identifying detail lives. */
function portalUrl(reference: string): string {
  const base = (process.env.PORTAL_BASE_URL ?? 'https://portal.example.com').replace(/\/+$/, '');
  return `${base}/b/${encodeURIComponent(reference)}`;
}

/**
 * Env test recipients (AC: "verified on test numbers/addresses"). When set they
 * OVERRIDE the patient's real contact in the synthetic Phase-1 demo so a real
 * Twilio/SendGrid send lands on the operator's own test number/inbox — never a
 * synthetic persona's. Falls back to the captured contact when unset.
 */
function patientSmsTo(contacts: DispatchContacts): string | null {
  return process.env.NOTIFY_TEST_SMS?.trim() || contacts.patientPhone?.trim() || null;
}
function patientEmailTo(contacts: DispatchContacts): string | null {
  return process.env.NOTIFY_TEST_EMAIL?.trim() || contacts.patientEmail?.trim() || null;
}
function clinicSmsTo(): string | null {
  return process.env.CLINIC_NOTIFY_SMS?.trim() || null;
}
function clinicEmailTo(): string | null {
  return process.env.CLINIC_NOTIFY_EMAIL?.trim() || null;
}

interface SendArgs {
  audience: NotifyAudience;
  to: string;
  /** Message minus the recipient — `to` is supplied separately and merged in. */
  msg: Omit<OutboundMessage, 'to'>;
  phi: BookingPhi;
  adapter: ReturnType<typeof resolveSmsAdapter>;
}

/** Send one message with the fail-closed PHI guard + masking applied. */
async function sendGuarded({ audience, to, msg, phi, adapter }: SendArgs): Promise<NotificationDelivery> {
  const recipientMasked = maskRecipient(to);
  const base = { channel: adapter.channel, audience, recipientMasked, simulated: adapter.simulated };
  // Fail-closed: refuse to transmit a body that leaks any PHI field.
  const leaks = findPhiLeaks([msg.subject, msg.body].filter(Boolean).join('\n'), phi);
  if (leaks.length > 0) {
    return { ...base, status: 'blocked', error: `phi_leak:${leaks.join(',')}` };
  }
  const res = await adapter.send({ ...msg, to });
  return {
    ...base,
    status: res.ok ? 'sent' : 'failed',
    providerId: res.providerId ?? null,
    simulated: res.simulated,
    error: res.error ?? null,
  };
}

/**
 * Dispatch the patient SMS + email and the clinic notification for a confirmed
 * booking. Returns one delivery record per attempted channel (audience-tagged).
 * A 'skipped' record is emitted when a recipient is not configured, so the caller
 * can see exactly what did/didn't go out.
 */
export async function dispatchBookingConfirmations(input: DispatchBookingInput): Promise<NotificationDelivery[]> {
  const sms = resolveSmsAdapter();
  const email = resolveEmailAdapter();
  const url = portalUrl(input.reference);
  const patientSms = buildSmsConfirmation({ reference: input.reference, portalUrl: url, clinicName: input.clinicName });
  const patientEmail = buildEmailConfirmation({ reference: input.reference, portalUrl: url, clinicName: input.clinicName });

  const deliveries: NotificationDelivery[] = [];

  const smsTo = patientSmsTo(input.contacts);
  deliveries.push(
    smsTo
      ? await sendGuarded({ audience: 'patient', to: smsTo, msg: patientSms, phi: input.phi, adapter: sms })
      : { channel: 'sms', audience: 'patient', recipientMasked: '(none)', status: 'skipped', simulated: sms.simulated },
  );

  const emailTo = patientEmailTo(input.contacts);
  deliveries.push(
    emailTo
      ? await sendGuarded({ audience: 'patient', to: emailTo, msg: patientEmail, phi: input.phi, adapter: email })
      : { channel: 'email', audience: 'patient', recipientMasked: '(none)', status: 'skipped', simulated: email.simulated },
  );

  // Clinic notification — also PHI-free: just "a booking landed, see the portal".
  const clinicBody = `New booking confirmed (ref ${input.reference}). View in the clinic portal: ${url}`;
  const cSms = clinicSmsTo();
  if (cSms) {
    deliveries.push(await sendGuarded({ audience: 'clinic', to: cSms, msg: { body: clinicBody }, phi: input.phi, adapter: sms }));
  }
  const cEmail = clinicEmailTo();
  if (cEmail) {
    deliveries.push(await sendGuarded({ audience: 'clinic', to: cEmail, msg: { subject: 'New booking confirmed', body: clinicBody }, phi: input.phi, adapter: email }));
  }

  return deliveries;
}

/**
 * Notify the clinic that a live call was escalated to a human (WS4). PHI-free —
 * the staff member pulls the patient context from the portal/queue, not the SMS.
 */
export async function dispatchEscalationNotice(input: {
  reference: string;
  reason: string;
  clinicName?: string | null;
}): Promise<NotificationDelivery[]> {
  const sms = resolveSmsAdapter();
  const email = resolveEmailAdapter();
  const url = portalUrl(input.reference);
  const body =
    `A patient call needs a human (reason: ${input.reason}, ref ${input.reference}). ` +
    `Open the queue in the clinic portal: ${url}`;
  const deliveries: NotificationDelivery[] = [];
  const cSms = clinicSmsTo();
  if (cSms) deliveries.push(await sendGuarded({ audience: 'clinic', to: cSms, msg: { body }, phi: {}, adapter: sms }));
  const cEmail = clinicEmailTo();
  if (cEmail) deliveries.push(await sendGuarded({ audience: 'clinic', to: cEmail, msg: { subject: 'Patient call escalated', body }, phi: {}, adapter: email }));
  return deliveries;
}
