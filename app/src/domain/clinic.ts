/**
 * Clinic domain — the booking RULES engine (SAU-267, Phase 0).
 *
 * This is the heart of the "training simulator → action-taking agent" evolution:
 * the clinic's hard constraints (operating hours, slot length, accepted insurance,
 * known doctors, no double-booking) live HERE, in deterministic, testable code —
 * NOT in the agent's prompt (AC #2). The persona may *describe* the rules to sound
 * natural, but the booking tool is the only thing that can actually create an
 * appointment, and it refuses anything that violates these constraints regardless
 * of what the model "agreed" to in conversation.
 *
 * Everything in this file is PURE: given a clinic config, a requested window, and
 * the set of currently-busy events, it computes open slots / validates a booking.
 * The calendar I/O (read busy events, create the event) lives behind the Calendar
 * adapter seam (services/calendar) and is injected by the booking service.
 */

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
}

/** A weekday's opening window in local clinic time. `null` = closed that day. */
export interface DayHours {
  /** minutes from midnight, e.g. 9 * 60 = 540 for 09:00 */
  openMin: number;
  closeMin: number;
}

export interface ClinicConfig {
  name: string;
  /** IANA tz the hours below are expressed in (display/authoring only; slot math is UTC-anchored via ISO inputs). */
  timezone: string;
  /** Index 0=Sunday … 6=Saturday (matches JS Date.getUTCDay). `null` = closed. */
  hours: Array<DayHours | null>;
  /** Appointment granularity, in minutes (also the default visit length). */
  slotMinutes: number;
  doctors: Doctor[];
  /** Insurance plans the clinic accepts (case-insensitive match). */
  insuranceAccepted: string[];
}

/**
 * The sample clinic used by the `clinic-intake-booking` Phase-0 scenario. The
 * scenario briefing describes these same facts to the persona so the conversation
 * is coherent — but THIS object is the enforcement source of truth.
 */
export const DEFAULT_CLINIC: ClinicConfig = {
  name: 'Riverside Family Health',
  timezone: 'America/New_York',
  hours: [
    null, // Sun — closed
    { openMin: 9 * 60, closeMin: 17 * 60 }, // Mon 09:00–17:00
    { openMin: 9 * 60, closeMin: 17 * 60 }, // Tue
    { openMin: 9 * 60, closeMin: 17 * 60 }, // Wed
    { openMin: 9 * 60, closeMin: 17 * 60 }, // Thu
    { openMin: 9 * 60, closeMin: 16 * 60 }, // Fri 09:00–16:00
    null, // Sat — closed
  ],
  slotMinutes: 30,
  doctors: [
    { id: 'dr-chen', name: 'Dr. Amara Chen', specialty: 'Family Medicine' },
    { id: 'dr-okafor', name: 'Dr. David Okafor', specialty: 'Pediatrics' },
  ],
  insuranceAccepted: ['Aetna', 'Blue Cross Blue Shield', 'Cigna', 'UnitedHealthcare', 'Medicare', 'Self-pay'],
};

/** A busy interval on a doctor's calendar (from the Calendar adapter). */
export interface BusyEvent {
  doctorId: string;
  startMs: number;
  endMs: number;
}

/** An open appointment slot the agent can offer the patient. */
export interface OpenSlot {
  doctorId: string;
  doctorName: string;
  startMs: number;
  endMs: number;
  /** ISO 8601 for display / passing back to create_appointment. */
  startIso: string;
  endIso: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function findDoctor(clinic: ClinicConfig, ref: string | undefined | null): Doctor | null {
  if (!ref) return null;
  const needle = ref.trim().toLowerCase();
  return (
    clinic.doctors.find((d) => d.id === needle) ??
    clinic.doctors.find((d) => d.name.toLowerCase() === needle) ??
    // loose contains match so "Chen" / "Dr. Chen" resolve to "Dr. Amara Chen"
    clinic.doctors.find((d) => d.name.toLowerCase().includes(needle) || needle.includes(d.name.toLowerCase().replace(/^dr\.?\s*/, ''))) ??
    null
  );
}

export function isInsuranceAccepted(clinic: ClinicConfig, insurance: string | undefined | null): boolean {
  if (!insurance) return false;
  const needle = insurance.trim().toLowerCase();
  return clinic.insuranceAccepted.some((p) => p.toLowerCase() === needle || p.toLowerCase().includes(needle) || needle.includes(p.toLowerCase()));
}

/** Minutes-from-midnight (UTC) for a timestamp, and its weekday index. */
function dayParts(ms: number): { weekday: number; minOfDay: number; dayStartMs: number } {
  const d = new Date(ms);
  const weekday = d.getUTCDay();
  const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dayStartMs = ms - minOfDay * 60_000 - d.getUTCSeconds() * 1000 - d.getUTCMilliseconds();
  return { weekday, minOfDay, dayStartMs };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Compute open slots for the clinic across a date range, for one doctor or all.
 * Slots are aligned to the clinic's opening minute and `slotMinutes` granularity,
 * fall fully within operating hours, and exclude any that collide with a busy
 * event for that doctor. Deterministic — depends only on its inputs.
 *
 * NOTE: hours are interpreted against UTC wall-clock for Phase-0 simplicity (the
 * scenario uses UTC slots end-to-end). Real per-timezone localization is Phase 1.
 */
export function computeOpenSlots(
  clinic: ClinicConfig,
  range: { fromMs: number; toMs: number },
  busy: BusyEvent[],
  doctorRef?: string | null,
  limit = 12,
): OpenSlot[] {
  const targetDoctors = doctorRef ? [findDoctor(clinic, doctorRef)].filter(Boolean) as Doctor[] : clinic.doctors;
  if (targetDoctors.length === 0) return [];
  const slots: OpenSlot[] = [];
  const from = Math.max(range.fromMs, Date.parse('1970-01-01T00:00:00Z') >= 0 ? range.fromMs : range.fromMs);

  // Walk day-by-day from the range start to its end.
  let cursorDay = dayParts(from).dayStartMs;
  const hardEnd = range.toMs;
  let guard = 0;
  while (cursorDay <= hardEnd && guard < 90) {
    guard += 1;
    const { weekday } = dayParts(cursorDay);
    const dh = clinic.hours[weekday];
    if (dh) {
      for (let m = dh.openMin; m + clinic.slotMinutes <= dh.closeMin; m += clinic.slotMinutes) {
        const startMs = cursorDay + m * 60_000;
        const endMs = startMs + clinic.slotMinutes * 60_000;
        if (startMs < from || endMs > hardEnd) continue;
        for (const doc of targetDoctors) {
          const clash = busy.some((b) => b.doctorId === doc.id && overlaps(startMs, endMs, b.startMs, b.endMs));
          if (clash) continue;
          slots.push({
            doctorId: doc.id,
            doctorName: doc.name,
            startMs,
            endMs,
            startIso: new Date(startMs).toISOString(),
            endIso: new Date(endMs).toISOString(),
          });
          if (slots.length >= limit) return slots.sort((a, b) => a.startMs - b.startMs);
        }
      }
    }
    cursorDay += DAY_MS;
  }
  return slots.sort((a, b) => a.startMs - b.startMs);
}

export type BookingRejection =
  | 'unknown_doctor'
  | 'bad_slot'
  | 'outside_hours'
  | 'double_book';

export interface BookingValidation {
  ok: boolean;
  doctor?: Doctor;
  startMs?: number;
  endMs?: number;
  reason?: BookingRejection;
  message?: string;
}

/**
 * Validate a requested booking against the clinic's hard rules. Returns the
 * resolved doctor + normalized slot bounds when valid, or a typed rejection. The
 * booking service calls this BEFORE creating the calendar event, so a violation
 * can never reach the calendar — the prompt has no authority here (AC #2).
 */
export function validateBooking(
  clinic: ClinicConfig,
  req: { doctor?: string | null; slotStartIso?: string | null; slotEndIso?: string | null },
  busy: BusyEvent[],
): BookingValidation {
  const doctor = findDoctor(clinic, req.doctor);
  if (!doctor) {
    return { ok: false, reason: 'unknown_doctor', message: `Unknown doctor. The clinic's doctors are: ${clinic.doctors.map((d) => d.name).join(', ')}.` };
  }
  const startMs = req.slotStartIso ? Date.parse(req.slotStartIso) : NaN;
  if (!Number.isFinite(startMs)) {
    return { ok: false, reason: 'bad_slot', message: 'A valid appointment start time (ISO 8601) is required.' };
  }
  // Honor an explicit end, else apply the clinic's standard slot length.
  const endMs = req.slotEndIso && Number.isFinite(Date.parse(req.slotEndIso))
    ? Date.parse(req.slotEndIso)
    : startMs + clinic.slotMinutes * 60_000;
  if (endMs <= startMs) {
    return { ok: false, reason: 'bad_slot', message: 'Appointment end must be after its start.' };
  }

  const { weekday, minOfDay } = dayParts(startMs);
  const dh = clinic.hours[weekday];
  if (!dh) {
    return { ok: false, reason: 'outside_hours', message: `The clinic is closed that day. Open Mon–Fri only.` };
  }
  const lengthMin = (endMs - startMs) / 60_000;
  const endMinOfDay = minOfDay + lengthMin;
  if (minOfDay < dh.openMin || endMinOfDay > dh.closeMin) {
    const fmt = (mm: number) => `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
    return { ok: false, reason: 'outside_hours', message: `That time is outside clinic hours (${fmt(dh.openMin)}–${fmt(dh.closeMin)} that day).` };
  }
  // Slot must align to the clinic's grid (no 9:07 starts).
  if ((minOfDay - dh.openMin) % clinic.slotMinutes !== 0) {
    return { ok: false, reason: 'bad_slot', message: `Appointments start on ${clinic.slotMinutes}-minute boundaries.` };
  }
  // Double-book guard: re-check against the live busy set for THIS doctor.
  const clash = busy.some((b) => b.doctorId === doctor.id && overlaps(startMs, endMs, b.startMs, b.endMs));
  if (clash) {
    return { ok: false, reason: 'double_book', message: `${doctor.name} is already booked at that time. Please pick another slot.` };
  }
  return { ok: true, doctor, startMs, endMs };
}
