/**
 * No-PHI booking-confirmation templates (SAU-277, WS5 — CISO content policy).
 *
 * Per the CISO-ratified content policy, the SMS/email booking confirmation body
 * carries ZERO PHI: no patient name, DOB, visit reason/diagnosis, provider name,
 * or appointment date/time. The patient receives a generic "your appointment is
 * confirmed" + an opaque confirmation reference + a link to the secure portal,
 * where every identifying/clinical detail lives behind authentication.
 *
 * This is the change that removes the email-provider BAA from the go-live gate:
 * if the message bodies never contain PHI, the transport (SMS/email) is not a PHI
 * conduit and needs no BAA. `findPhiLeaks` is the defense-in-depth guard so any
 * future template edit that reintroduces PHI fails loudly in tests.
 */

export interface ConfirmationInput {
  /**
   * Opaque booking reference shown to the patient (e.g. a short code or the
   * calendar event id). MUST NOT be derived from PHI (no name/DOB encoding).
   */
  reference: string;
  /** Absolute https URL to the secure patient portal where details live. */
  portalUrl: string;
  /** Public clinic display name (business identity, not PHI). Optional. */
  clinicName?: string | null;
}

export interface ConfirmationMessage {
  channel: 'sms' | 'email';
  /** Email subject line (email channel only). */
  subject?: string;
  body: string;
}

/** The PHI fields the booking flow handles — checked against by `findPhiLeaks`. */
export interface BookingPhi {
  patientName?: string | null;
  dob?: string | null;
  reason?: string | null;
  doctorName?: string | null;
  /** ISO start of the appointment slot. */
  startIso?: string | null;
}

const DETAIL_NOTICE =
  'For your privacy, your appointment details are available only in the secure ' +
  'patient portal.';

/** Generic, PHI-free SMS confirmation: clinic name + reference + portal link. */
export function buildSmsConfirmation(input: ConfirmationInput): ConfirmationMessage {
  const clinic = input.clinicName?.trim() || 'Your clinic';
  return {
    channel: 'sms',
    body:
      `${clinic}: your appointment is confirmed (ref ${input.reference}). ` +
      `View details and manage your booking securely: ${input.portalUrl}`,
  };
}

/** Generic, PHI-free email confirmation. Details deliberately live in the portal. */
export function buildEmailConfirmation(input: ConfirmationInput): ConfirmationMessage {
  const clinic = input.clinicName?.trim() || 'your clinic';
  const body = [
    'Hello,',
    '',
    'Your appointment is confirmed.',
    '',
    `Confirmation reference: ${input.reference}`,
    '',
    `${DETAIL_NOTICE} Please sign in to view or manage your booking:`,
    input.portalUrl,
    '',
    `If you did not request this appointment, please contact ${clinic}.`,
  ].join('\n');
  return { channel: 'email', subject: 'Your appointment is confirmed', body };
}

/**
 * Defense-in-depth: return the labels of any PHI fields that leak into a message
 * body (case-insensitive substring match). Empty array = clean. Short values
 * (< 3 chars) are skipped to avoid false positives on common substrings.
 */
export function findPhiLeaks(body: string, phi: BookingPhi): string[] {
  const hay = body.toLowerCase();
  const leaks: string[] = [];
  const check = (label: keyof BookingPhi, v?: string | null) => {
    const needle = v?.trim().toLowerCase();
    if (needle && needle.length >= 3 && hay.includes(needle)) leaks.push(label);
  };
  check('patientName', phi.patientName);
  check('dob', phi.dob);
  check('reason', phi.reason);
  check('doctorName', phi.doctorName);
  check('startIso', phi.startIso);
  return leaks;
}
