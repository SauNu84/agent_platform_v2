/**
 * Twilio handoff transport (SAU-273, WS4) — same vendor as telephony (SAU-270),
 * key-gated and fail-soft.
 *
 * Enabled when TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are present, plus
 * TWILIO_TRANSFER_TO (the clinic staff line) for warm transfers. It produces the
 * TwiML the bridge serves back on the live call:
 *   • warm_transfer → `<Dial>` the clinic staff number (a true warm transfer, with
 *     a brief whisper, lands with the bridge — SAU-282).
 *   • voicemail     → `<Record>` so an after-hours caller can leave a message.
 *   • callback      → acknowledge + enqueue a callback (queue persistence is the
 *     `clinic_notification` record the escalation service writes).
 *
 * Building TwiML is pure/local (no network) and cannot throw, so this never drops
 * a caller. A missing transfer target degrades a warm_transfer to voicemail rather
 * than failing — the caller is always given a path.
 */
import type { HandoffAdapter, HandoffRequest, HandoffResult } from './handoff-adapter';

export interface TwilioHandoffConfig {
  /** Clinic staff line to warm-transfer to (E.164). Optional → transfers degrade to voicemail. */
  transferTo?: string | null;
}

export function readTwilioHandoffConfig(): TwilioHandoffConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return null;
  return { transferTo: process.env.TWILIO_TRANSFER_TO?.trim() || null };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class TwilioHandoffAdapter implements HandoffAdapter {
  readonly label = 'Twilio handoff';
  readonly simulated = false;

  constructor(private readonly cfg: TwilioHandoffConfig) {}

  async handle(req: HandoffRequest): Promise<HandoffResult> {
    // Warm transfer needs a destination; without one we keep the caller by taking
    // a voicemail instead of failing (never drop them — AC #3).
    if (req.kind === 'warm_transfer' && this.cfg.transferTo) {
      const instruction =
        `<Response><Say>Connecting you to our team now.</Say>` +
        `<Dial answerOnBridge="true"><Number>${esc(this.cfg.transferTo)}</Number></Dial></Response>`;
      return { ok: true, kind: 'warm_transfer', instruction, simulated: false };
    }
    if (req.kind === 'callback') {
      const instruction = `<Response><Say>Thanks. A member of our team will call you back shortly.</Say><Hangup/></Response>`;
      return { ok: true, kind: 'callback', instruction, simulated: false };
    }
    // voicemail (and the degraded warm_transfer with no target)
    const instruction =
      `<Response><Say>Our office is currently closed. Please leave a message after the tone and we'll return your call.</Say>` +
      `<Record maxLength="120" playBeep="true"/></Response>`;
    return { ok: true, kind: 'voicemail', instruction, simulated: false };
  }
}
