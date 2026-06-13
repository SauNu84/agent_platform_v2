/**
 * Clinic session finalization (SAU-267) — the task-completion projection.
 *
 * Called after a clinic-intake session is persisted. It does two things the
 * scoring Analyst does NOT:
 *   1. Extracts a validated structured intake JSON from the transcript (AC #4).
 *   2. Derives a task OUTCOME — booked / no_slot / escalated — from the
 *      `create_appointment` tool results in the transcript, keeping the created
 *      event id as proof of completion (AC #5).
 * Both are stored in `clinic_session_outcome` (migration 0016).
 *
 * The calendar event itself was ALREADY created during the call by the server
 * tool executor — finalization only reads the result back, so it never
 * double-books.
 */
import type { ScenarioRecord } from '@/domain/scenario';
import type { Store, ClinicOutcomeRecord, ClinicOutcome, SessionTranscript } from '@/db/store';
import { CLINIC_TOOL_NAMES } from '@/services/clinic-booking';
import { extractIntake } from '@/intake/extractor';

/** A scenario is a clinic action-agent when it wires the booking tools. */
export function isClinicScenario(scenario: ScenarioRecord): boolean {
  const names = new Set(scenario.tools.map((t) => t.name));
  return CLINIC_TOOL_NAMES.some((n) => names.has(n));
}

interface BookingResult {
  booked?: boolean;
  reason?: string;
  eventId?: string;
  htmlLink?: string;
  doctorId?: string;
  doctorName?: string;
  start?: string;
  end?: string;
  calendar?: string;
  simulated?: boolean;
  slots?: unknown[];
}

/** Decide the outcome from the session's tool-call results. */
export function deriveOutcome(toolCalls: SessionTranscript['toolCalls']): {
  outcome: ClinicOutcome;
  booking: BookingResult | null;
} {
  const creates = toolCalls.filter((c) => c.name === 'create_appointment');
  const checks = toolCalls.filter((c) => c.name === 'check_availability');

  // 1) A successful booking wins outright.
  const booked = creates
    .map((c) => c.result as BookingResult | undefined)
    .find((r) => r && r.booked === true);
  if (booked) return { outcome: 'booked', booking: booked };

  // 2) Genuine "no slot": a booking was attempted and failed on availability, OR
  //    every availability check came back empty.
  const availabilityFail = creates.some((c) => {
    const r = c.result as BookingResult | undefined;
    return r && r.booked === false && (r.reason === 'double_book' || r.reason === 'outside_hours' || r.reason === 'bad_slot');
  });
  const allChecksEmpty = checks.length > 0 && checks.every((c) => {
    const r = c.result as BookingResult | undefined;
    return r && Array.isArray(r.slots) && r.slots.length === 0;
  });
  if (availabilityFail || allChecksEmpty) return { outcome: 'no_slot', booking: null };

  // 3) Otherwise the agent didn't complete the task → escalate to a human.
  return { outcome: 'escalated', booking: null };
}

/**
 * Extract intake + derive outcome for a finished clinic session and persist it.
 * Returns the stored record so the caller can echo it in the API response.
 */
export async function finalizeClinicSession(opts: {
  store: Store;
  scenario: ScenarioRecord;
  sessionId: string;
  userId: string | null;
  /** owning clinic/org for multi-clinic PHI scoping (SAU-275); null = platform. */
  clinicId?: string | null;
  transcript: SessionTranscript;
}): Promise<ClinicOutcomeRecord> {
  const { store, scenario, sessionId, userId, clinicId = null, transcript } = opts;
  const intake = await extractIntake({ turns: transcript.turns, toolCalls: transcript.toolCalls });
  const { outcome, booking } = deriveOutcome(transcript.toolCalls);

  const rec: ClinicOutcomeRecord = {
    sessionId,
    scenarioId: scenario.id,
    userId,
    clinicId,
    outcome,
    eventId: booking?.eventId ?? null,
    eventLink: booking?.htmlLink ?? null,
    doctorId: booking?.doctorId ?? null,
    doctorName: booking?.doctorName ?? null,
    slotStart: booking?.start ?? null,
    slotEnd: booking?.end ?? null,
    calendar: booking?.calendar ?? null,
    simulated: booking?.simulated ?? true,
    intake: intake as unknown as Record<string, unknown>,
  };
  return store.recordClinicOutcome(rec);
}
