/**
 * Clinic booking service (SAU-267) — the SERVER-SIDE tool executors behind the
 * ADR-005 tool seam. These are what the realtime voice agent's `check_availability`
 * and `create_appointment` function calls actually run: they read/write a real
 * calendar through the adapter seam and enforce the clinic's hard rules via the
 * pure `domain/clinic` engine. The agent's prompt cannot override them (AC #2).
 *
 * The browser forwards each model function-call to /api/scenarios/[slug]/tools,
 * which dispatches here; the structured result is fed back into the realtime
 * session so the agent can speak it. Created events carry a real id = proof of
 * completion (AC #1).
 */
import {
  DEFAULT_CLINIC, computeOpenSlots, validateBooking, findDoctor, isInsuranceAccepted,
  type ClinicConfig, type BusyEvent,
} from '@/domain/clinic';
import { getCalendarAdapter, type CalendarAdapter } from '@/services/calendar';

/** A booking window in days from "now"; the agent rarely needs more than a week. */
const DEFAULT_LOOKAHEAD_DAYS = 7;

export interface CheckAvailabilityArgs {
  doctor?: string | null;
  /** ISO date or datetime; defaults to now. */
  from?: string | null;
  /** ISO date or datetime; defaults to from + 7 days. */
  to?: string | null;
}

export interface CheckAvailabilityResult {
  clinic: string;
  calendar: string;
  simulated: boolean;
  slots: Array<{ doctorId: string; doctorName: string; start: string; end: string }>;
  doctors: Array<{ id: string; name: string; specialty: string }>;
  note?: string;
}

export interface CreateAppointmentArgs {
  patientName?: string | null;
  doctor?: string | null;
  /** ISO 8601 start of the chosen slot. */
  slotStart?: string | null;
  /** Optional ISO end; defaults to the clinic's standard slot length. */
  slotEnd?: string | null;
  reason?: string | null;
  insurance?: string | null;
  dob?: string | null;
  /** Patient callback number for the confirmation SMS (contact PHI; body stays PHI-free). */
  patientPhone?: string | null;
  /** Patient email for the confirmation email (contact PHI). */
  patientEmail?: string | null;
}

export type CreateAppointmentResult =
  | {
      booked: true;
      eventId: string;
      htmlLink?: string;
      doctorId: string;
      doctorName: string;
      start: string;
      end: string;
      calendar: string;
      simulated: boolean;
      insuranceAccepted: boolean;
      /** Echoed back so the confirmation dispatcher can reach the patient. */
      patientPhone?: string | null;
      patientEmail?: string | null;
    }
  | {
      booked: false;
      reason: 'unknown_doctor' | 'bad_slot' | 'outside_hours' | 'double_book' | 'missing_fields';
      message: string;
    };

export interface ClinicDeps {
  clinic?: ClinicConfig;
  calendar?: CalendarAdapter;
  /** injectable clock for deterministic tests */
  nowMs?: number;
}

function resolve(deps?: ClinicDeps): { clinic: ClinicConfig; calendar: CalendarAdapter; now: number } {
  return {
    clinic: deps?.clinic ?? DEFAULT_CLINIC,
    calendar: deps?.calendar ?? getCalendarAdapter(),
    now: deps?.nowMs ?? Date.now(),
  };
}

export async function checkAvailability(args: CheckAvailabilityArgs, deps?: ClinicDeps): Promise<CheckAvailabilityResult> {
  const { clinic, calendar, now } = resolve(deps);
  const fromMs = args.from && Number.isFinite(Date.parse(args.from)) ? Date.parse(args.from) : now;
  const toMs = args.to && Number.isFinite(Date.parse(args.to))
    ? Date.parse(args.to)
    : fromMs + DEFAULT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

  const busyRaw = await calendar.listBusy({ fromMs, toMs }, args.doctor ? findDoctor(clinic, args.doctor)?.id : undefined);
  const busy: BusyEvent[] = busyRaw.map((b) => ({ doctorId: b.doctorId, startMs: b.startMs, endMs: b.endMs }));
  const slots = computeOpenSlots(clinic, { fromMs, toMs }, busy, args.doctor ?? null);

  return {
    clinic: clinic.name,
    calendar: calendar.label,
    simulated: calendar.simulated,
    slots: slots.map((s) => ({ doctorId: s.doctorId, doctorName: s.doctorName, start: s.startIso, end: s.endIso })),
    doctors: clinic.doctors.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty })),
    note: slots.length === 0 ? 'No open slots in that window — try a different date range or doctor.' : undefined,
  };
}

export async function createAppointment(args: CreateAppointmentArgs, deps?: ClinicDeps): Promise<CreateAppointmentResult> {
  const { clinic, calendar } = resolve(deps);

  if (!args.patientName || !args.patientName.trim()) {
    return { booked: false, reason: 'missing_fields', message: "I still need the patient's name before I can book." };
  }

  // Re-read busy state at booking time so the double-book guard is decided on the
  // freshest data (a slot offered earlier may have been taken).
  const startMs = args.slotStart ? Date.parse(args.slotStart) : NaN;
  if (!Number.isFinite(startMs)) {
    return { booked: false, reason: 'bad_slot', message: 'A valid appointment time is required.' };
  }
  const doc = findDoctor(clinic, args.doctor);
  const busyRaw = await calendar.listBusy(
    { fromMs: startMs - 60_000, toMs: startMs + clinic.slotMinutes * 60_000 + 60_000 },
    doc?.id,
  );
  const busy: BusyEvent[] = busyRaw.map((b) => ({ doctorId: b.doctorId, startMs: b.startMs, endMs: b.endMs }));

  const v = validateBooking(clinic, { doctor: args.doctor, slotStartIso: args.slotStart, slotEndIso: args.slotEnd }, busy);
  if (!v.ok || !v.doctor || v.startMs == null || v.endMs == null) {
    return { booked: false, reason: v.reason ?? 'bad_slot', message: v.message ?? 'Unable to book that slot.' };
  }

  const summary = `${args.patientName.trim()} — ${args.reason?.trim() || 'Appointment'} (${v.doctor.name})`;
  const description = [
    `Patient: ${args.patientName.trim()}`,
    args.dob ? `DOB: ${args.dob}` : null,
    args.reason ? `Reason: ${args.reason}` : null,
    args.insurance ? `Insurance: ${args.insurance}` : null,
    'Booked by AI Clinic Intake & Booking agent (synthetic Phase-0 spike).',
  ].filter(Boolean).join('\n');

  const event = await calendar.createEvent({
    doctorId: v.doctor.id,
    summary,
    description,
    startMs: v.startMs,
    endMs: v.endMs,
  });

  return {
    booked: true,
    eventId: event.id,
    htmlLink: event.htmlLink,
    doctorId: v.doctor.id,
    doctorName: v.doctor.name,
    start: new Date(v.startMs).toISOString(),
    end: new Date(v.endMs).toISOString(),
    calendar: calendar.label,
    simulated: calendar.simulated,
    insuranceAccepted: isInsuranceAccepted(clinic, args.insurance),
    patientPhone: args.patientPhone?.trim() || null,
    patientEmail: args.patientEmail?.trim() || null,
  };
}

/** Dispatch a tool by its registry name. Used by the server tool endpoint. */
export async function runClinicTool(name: string, args: unknown, deps?: ClinicDeps): Promise<unknown> {
  if (name === 'check_availability') return checkAvailability((args ?? {}) as CheckAvailabilityArgs, deps);
  if (name === 'create_appointment') return createAppointment((args ?? {}) as CreateAppointmentArgs, deps);
  throw new Error(`unknown clinic tool: ${name}`);
}

export const CLINIC_TOOL_NAMES = ['check_availability', 'create_appointment'] as const;
