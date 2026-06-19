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
import { DEFAULT_CLINIC } from '@/domain/clinic';
import { isAfterHours } from '@/domain/escalation';
import { getClinicConfig } from '@/services/clinic-config';
import { dispatchBookingConfirmations, type NotificationDelivery } from '@/services/clinic-notify';
import { handleEscalation } from '@/services/clinic-escalation';
import { trackSafe } from '@/services/product-analytics';
import { PRODUCT_EVENTS } from '@/domain/analytics-events';
import type { BookingPhi } from '@/services/clinic-confirmation';

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
  patientPhone?: string | null;
  patientEmail?: string | null;
}

/** Roll up the per-channel deliveries into one summary for the outcome row. */
function summarizeConfirmations(deliveries: NotificationDelivery[]): string {
  if (deliveries.some((d) => d.status === 'blocked')) return 'blocked';
  const attempted = deliveries.filter((d) => d.status !== 'skipped');
  if (attempted.length === 0) return 'skipped';
  const sent = attempted.filter((d) => d.status === 'sent').length;
  if (sent === attempted.length) return 'sent';
  if (sent > 0) return 'partial';
  return 'failed';
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
  // Use THIS operator's authored clinic (SAU-300) for the confirmation/escalation
  // copy + after-hours behavior; falls back to DEFAULT_CLINIC when none is authored.
  const clinic = userId ? await getClinicConfig(store, userId, clinicId) : DEFAULT_CLINIC;
  const clinicName = clinic.name;
  // After-hours signal for the ops dashboard (SAU-301): derived from the clinic's
  // own hours table at finalize time, for every outcome (not just escalations).
  const afterHours = isAfterHours(clinic.hours, Date.now());

  // Close-the-loop side effects (SAU-273). Both are best-effort and fail-soft —
  // a confirmation/handoff problem must never undo a completed booking or throw
  // out of finalization. The PHI guard inside dispatch is fail-CLOSED separately.
  let confirmationStatus: string | null = null;
  let escalationReason: string | null = null;
  let handoffAction: string | null = null;
  const deliveries: NotificationDelivery[] = [];

  if (outcome === 'booked' && booking?.eventId) {
    // WS3: tell the patient (SMS + email) + notify the clinic. PHI-free bodies.
    const phi: BookingPhi = {
      patientName: intake.patientName,
      dob: intake.dob,
      reason: intake.reasonForVisit,
      doctorName: booking.doctorName ?? null,
      startIso: booking.start ?? null,
    };
    try {
      const sent = await dispatchBookingConfirmations({
        reference: booking.eventId,
        clinicName,
        contacts: {
          patientPhone: booking.patientPhone ?? intake.phone,
          patientEmail: booking.patientEmail ?? null,
        },
        phi,
      });
      deliveries.push(...sent);
      confirmationStatus = summarizeConfirmations(sent);
    } catch {
      confirmationStatus = 'failed';
    }
  } else if (outcome === 'escalated') {
    // WS4: route the live caller to a human (or after-hours voicemail/callback)
    // and notify the clinic. Outcome stays `escalated`; we record HOW it was handled.
    try {
      const esc = await handleEscalation({
        turns: transcript.turns,
        outcome,
        reference: sessionId,
        clinic,
        clinicName,
      });
      escalationReason = esc.reason;
      handoffAction = esc.action;
      deliveries.push(...esc.notifications);
    } catch {
      /* never let a handoff problem fail finalization */
    }
  }

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
    escalationReason,
    handoffAction,
    confirmationStatus,
    afterHours,
  };
  const saved = await store.recordClinicOutcome(rec);

  // Persist the delivery log (no PHI — masked recipient only).
  const reference = booking?.eventId ?? sessionId;
  for (const d of deliveries) {
    await store.recordClinicNotification({
      sessionId,
      userId,
      clinicId,
      reference,
      channel: d.channel,
      audience: d.audience,
      recipientMasked: d.recipientMasked,
      status: d.status,
      providerId: d.providerId ?? null,
      simulated: d.simulated,
      error: d.error ?? null,
    });
  }

  // SAU-358 (WS5 §6): emit the Clinic archetype VALUE events from this canonical
  // task-completion seam — the only clinic boundary that already holds `store` +
  // tenant (`clinicId`) + outcome. The store-less executors above never see the
  // store, so this is where the funnel's bottom steps are fed. Best-effort and
  // PII-FREE by construction (enums / counts / bools only — never intake content).
  await emitClinicOutcomeEvents(store, {
    sessionId, scenarioId: scenario.id, userId, clinicId,
    outcome, confirmationStatus, escalationReason, handoffAction, afterHours,
    turns: transcript.turns.length, deliveries: deliveries.length,
  });

  return saved;
}

/**
 * Emit the Clinic archetype product events (SAU-350 §6 emit-map, wired by SAU-358).
 * Always logs `clinic.session.completed` (the "ran a session" funnel step); then,
 * per outcome, the value/branch events. Props carry enums/counts ONLY.
 */
async function emitClinicOutcomeEvents(
  store: Store,
  ctx: {
    sessionId: string; scenarioId: string; userId: string | null; clinicId: string | null;
    outcome: ClinicOutcome; confirmationStatus: string | null;
    escalationReason: string | null; handoffAction: string | null;
    afterHours: boolean; turns: number; deliveries: number;
  },
): Promise<void> {
  const base = {
    actorId: ctx.userId, tenantId: ctx.clinicId,
    sessionId: ctx.sessionId, scenarioId: ctx.scenarioId,
  };
  await trackSafe(store, {
    ...base,
    event: PRODUCT_EVENTS.CLINIC_SESSION_COMPLETED,
    props: { outcome: ctx.outcome, turns: ctx.turns, after_hours: ctx.afterHours },
  });
  if (ctx.outcome === 'booked') {
    await trackSafe(store, {
      ...base,
      event: PRODUCT_EVENTS.CLINIC_BOOKING_COMPLETED, // the funnel VALUE step
      props: { after_hours: ctx.afterHours, confirmation: ctx.confirmationStatus ?? 'none' },
    });
    // Patient/clinic confirmation actually dispatched (sent or partial).
    if (ctx.confirmationStatus === 'sent' || ctx.confirmationStatus === 'partial') {
      await trackSafe(store, {
        ...base,
        event: PRODUCT_EVENTS.CLINIC_CONFIRMATION_SENT,
        props: { status: ctx.confirmationStatus, channels: ctx.deliveries },
      });
    }
  } else if (ctx.outcome === 'escalated') {
    await trackSafe(store, {
      ...base,
      event: PRODUCT_EVENTS.CLINIC_ESCALATED,
      props: {
        // NB: key is `trigger`, not `reason` — `reason` is a forbidden PII key in
        // the track() guard (and any key *containing* "reason" trips it too).
        trigger: ctx.escalationReason ?? 'unresolved',
        handoff: ctx.handoffAction ?? 'none',
        after_hours: ctx.afterHours,
      },
    });
  }
}
