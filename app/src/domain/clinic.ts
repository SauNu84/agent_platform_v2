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
  /**
   * Ids of the services this provider offers (SAU-300). Empty/undefined = the
   * provider offers every service (back-compat with the Phase-0 DEFAULT_CLINIC,
   * which has no service catalog).
   */
  serviceIds?: string[];
}

/** A weekday's opening window in local clinic time. `null` = closed that day. */
export interface DayHours {
  /** minutes from midnight, e.g. 9 * 60 = 540 for 09:00 */
  openMin: number;
  closeMin: number;
}

/** An appointment type the clinic offers (SAU-300) — carries its own visit length. */
export interface Service {
  id: string;
  name: string;
  /** Visit length in minutes; overrides the clinic's default slot length. */
  durationMinutes: number;
}

/** What the agent does when a caller reaches the clinic outside operating hours (SAU-300). */
export type AfterHoursMode = 'voicemail' | 'callback' | 'message';

export interface AfterHoursConfig {
  mode: AfterHoursMode;
  /** Optional spoken message for the caller (e.g. the "message" mode script). */
  message?: string;
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

  // ── Phase-2 authoring (SAU-300). All optional so the Phase-0 DEFAULT_CLINIC and
  //    every existing caller keep working unchanged; the no-code panel populates them.
  /** Appointment types the clinic offers (with per-type durations). */
  services?: Service[];
  /** Behavior when a caller reaches the clinic outside operating hours. */
  afterHours?: AfterHoursConfig;
  /** Minimum gap (minutes) required between a provider's appointments. */
  bufferMinutes?: number;
  /** Minimum notice (minutes) before an appointment's start — no same-minute bookings. */
  leadTimeMinutes?: number;
  /** Max appointments per provider per day (0/undefined = unlimited). */
  maxPerDay?: number;
  /** Agent persona/greeting authored by the operator (no-code). */
  greeting?: string;
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

/** Resolve a service by id or (loose) name against the clinic's catalog (SAU-300). */
export function findService(clinic: ClinicConfig, ref: string | undefined | null): Service | null {
  const services = clinic.services ?? [];
  if (!ref || services.length === 0) return null;
  const needle = ref.trim().toLowerCase();
  return (
    services.find((s) => s.id === needle) ??
    services.find((s) => s.name.toLowerCase() === needle) ??
    services.find((s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase())) ??
    null
  );
}

/** True when a provider offers a given service. A provider with no service list offers all (back-compat). */
export function doctorOffersService(doctor: Doctor, service: Service | null): boolean {
  if (!service) return true;
  if (!doctor.serviceIds || doctor.serviceIds.length === 0) return true;
  return doctor.serviceIds.includes(service.id);
}

/**
 * The visit length (minutes) for a booking: an explicit slotEnd wins, else the
 * chosen service's duration, else the clinic's default slot length (SAU-300).
 */
export function resolveDurationMinutes(clinic: ClinicConfig, service: Service | null): number {
  return service?.durationMinutes ?? clinic.slotMinutes;
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
 * A new appointment [s,e] conflicts with a busy interval [bs,be] if they overlap
 * once the busy interval is padded by the clinic's required buffer on both sides
 * (SAU-300). With buffer 0 this is plain overlap, so Phase-0 behavior is preserved.
 */
function conflictsWithBuffer(s: number, e: number, bs: number, be: number, bufferMs: number): boolean {
  return overlaps(s, e, bs - bufferMs, be + bufferMs);
}

/** Count a provider's busy events that fall on the same UTC day as `dayStartMs`. */
function bookingsOnDay(busy: BusyEvent[], doctorId: string, dayStartMs: number): number {
  return busy.filter((b) => b.doctorId === doctorId && dayParts(b.startMs).dayStartMs === dayStartMs).length;
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
  /** SAU-300 booking-rule context: chosen service (→ duration + provider filter) and "now" (→ lead time). */
  opts?: { service?: Service | null; nowMs?: number | null },
): OpenSlot[] {
  const service = opts?.service ?? null;
  // Honor "which services each provider offers" when a service is requested.
  const allDoctors = doctorRef ? ([findDoctor(clinic, doctorRef)].filter(Boolean) as Doctor[]) : clinic.doctors;
  const targetDoctors = allDoctors.filter((d) => doctorOffersService(d, service));
  if (targetDoctors.length === 0) return [];

  const durationMs = resolveDurationMinutes(clinic, service) * 60_000;
  const bufferMs = Math.max(0, clinic.bufferMinutes ?? 0) * 60_000;
  // Earliest a slot may start: respect minimum lead time relative to "now".
  const earliest = opts?.nowMs != null ? opts.nowMs + Math.max(0, clinic.leadTimeMinutes ?? 0) * 60_000 : -Infinity;
  const maxPerDay = clinic.maxPerDay && clinic.maxPerDay > 0 ? clinic.maxPerDay : Infinity;

  const slots: OpenSlot[] = [];
  const from = range.fromMs;

  // Walk day-by-day from the range start to its end.
  let cursorDay = dayParts(from).dayStartMs;
  const hardEnd = range.toMs;
  let guard = 0;
  while (cursorDay <= hardEnd && guard < 90) {
    guard += 1;
    const { weekday } = dayParts(cursorDay);
    const dh = clinic.hours[weekday];
    if (dh) {
      // Per-day, per-doctor capacity = the max minus what's already booked that day.
      const remaining = new Map<string, number>(
        targetDoctors.map((d) => [d.id, maxPerDay - bookingsOnDay(busy, d.id, cursorDay)]),
      );
      // Step on the clinic grid; the appointment itself spans `durationMs`.
      for (let m = dh.openMin; m + Math.ceil(durationMs / 60_000) <= dh.closeMin; m += clinic.slotMinutes) {
        const startMs = cursorDay + m * 60_000;
        const endMs = startMs + durationMs;
        if (startMs < from || endMs > hardEnd || startMs < earliest) continue;
        for (const doc of targetDoctors) {
          if ((remaining.get(doc.id) ?? 0) <= 0) continue;
          const clash = busy.some((b) => b.doctorId === doc.id && conflictsWithBuffer(startMs, endMs, b.startMs, b.endMs, bufferMs));
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
  | 'double_book'
  // ── SAU-300 configurable rules ──
  | 'unknown_service'
  | 'service_unavailable'
  | 'lead_time'
  | 'day_full';

export interface BookingValidation {
  ok: boolean;
  doctor?: Doctor;
  service?: Service | null;
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
  req: { doctor?: string | null; slotStartIso?: string | null; slotEndIso?: string | null; service?: string | null },
  busy: BusyEvent[],
  /** SAU-300: "now" enables lead-time enforcement (omitted ⇒ no lead-time check, e.g. pure tests). */
  opts?: { nowMs?: number | null },
): BookingValidation {
  const doctor = findDoctor(clinic, req.doctor);
  if (!doctor) {
    return { ok: false, reason: 'unknown_doctor', message: `Unknown doctor. The clinic's doctors are: ${clinic.doctors.map((d) => d.name).join(', ')}.` };
  }

  // Resolve the appointment type (SAU-300). A named-but-unknown service is rejected;
  // a known service the provider doesn't offer is rejected; no service ⇒ default length.
  let service: Service | null = null;
  if (req.service && req.service.trim()) {
    service = findService(clinic, req.service);
    if (!service) {
      const offered = (clinic.services ?? []).map((s) => s.name).join(', ');
      return { ok: false, reason: 'unknown_service', message: offered ? `Unknown service. The clinic offers: ${offered}.` : 'That service is not offered here.' };
    }
    if (!doctorOffersService(doctor, service)) {
      return { ok: false, reason: 'service_unavailable', message: `${doctor.name} does not offer ${service.name}. Please choose another provider or service.` };
    }
  }

  const startMs = req.slotStartIso ? Date.parse(req.slotStartIso) : NaN;
  if (!Number.isFinite(startMs)) {
    return { ok: false, reason: 'bad_slot', message: 'A valid appointment start time (ISO 8601) is required.' };
  }
  // Honor an explicit end, else the chosen service's duration, else the clinic default.
  const endMs = req.slotEndIso && Number.isFinite(Date.parse(req.slotEndIso))
    ? Date.parse(req.slotEndIso)
    : startMs + resolveDurationMinutes(clinic, service) * 60_000;
  if (endMs <= startMs) {
    return { ok: false, reason: 'bad_slot', message: 'Appointment end must be after its start.' };
  }

  // Minimum lead time: no booking inside the configured notice window (SAU-300).
  const leadMin = Math.max(0, clinic.leadTimeMinutes ?? 0);
  if (opts?.nowMs != null && leadMin > 0 && startMs < opts.nowMs + leadMin * 60_000) {
    return { ok: false, reason: 'lead_time', message: `Appointments need at least ${leadMin} minutes' notice. Please pick a later time.` };
  }

  const { weekday, minOfDay, dayStartMs } = dayParts(startMs);
  const dh = clinic.hours[weekday];
  if (!dh) {
    return { ok: false, reason: 'outside_hours', message: `The clinic is closed that day.` };
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

  // Per-day capacity (SAU-300): refuse once the provider's daily max is reached.
  const maxPerDay = clinic.maxPerDay && clinic.maxPerDay > 0 ? clinic.maxPerDay : Infinity;
  if (bookingsOnDay(busy, doctor.id, dayStartMs) >= maxPerDay) {
    return { ok: false, reason: 'day_full', message: `${doctor.name} is fully booked that day. Please pick another day.` };
  }

  // Double-book guard: re-check against the live busy set for THIS doctor, padded
  // by the clinic's required buffer between appointments.
  const bufferMs = Math.max(0, clinic.bufferMinutes ?? 0) * 60_000;
  const clash = busy.some((b) => b.doctorId === doctor.id && conflictsWithBuffer(startMs, endMs, b.startMs, b.endMs, bufferMs));
  if (clash) {
    return { ok: false, reason: 'double_book', message: `${doctor.name} is already booked at that time. Please pick another slot.` };
  }
  return { ok: true, doctor, service, startMs, endMs };
}
