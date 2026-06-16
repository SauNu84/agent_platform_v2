/**
 * Per-clinic ops dashboard read-model (SAU-301, Phase 2 · WS-B).
 *
 * Aggregates the SAU-267 booking outcomes + SAU-273 notification log for ONE
 * clinic into the metrics that prove the agent's ROI — mirroring the SAU-287
 * case-study success criteria (bookings, booking accuracy, escalation rate,
 * after-hours capture, PHI-safety). Reads go through the RLS-scoped store methods,
 * so a caller only ever aggregates clinics they're a member of; the metrics view
 * uses the NON-PHI outcome summary (no intake decrypt, no PHI audit noise).
 */
import type { Store, ClinicOutcomeSummary } from '@/db/store';

export interface ClinicDashboardMetrics {
  clinicId: string;
  totalCalls: number;
  booked: number;
  noSlot: number;
  escalated: number;
  /** booked / total */
  bookingRate: number;
  /** escalated / total */
  escalationRate: number;
  /** no_slot / total */
  noSlotRate: number;
  /** booked-with-a-real-calendar-event / booked — proof the booking actually landed. */
  bookingAccuracy: number;
  afterHoursTotal: number;
  /** after-hours calls that still reached an outcome (booked or a handoff) — never dropped. */
  afterHoursCaptured: number;
  /** after-hours calls with no booking and no handoff. */
  afterHoursDropped: number;
  /** outcomes whose booking confirmation dispatched (sent or partial). */
  confirmationsSent: number;
  /** PHI-leak guard activations on outbound notices (blocked sends) — leaks remain 0. */
  notificationsBlocked: number;
  /** the most recent outcomes (non-PHI) for the activity table. */
  recent: ClinicOutcomeSummary[];
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/** True when an after-hours call still reached a real outcome (the seam never drops a caller). */
function isCaptured(o: ClinicOutcomeSummary): boolean {
  if (o.outcome === 'booked') return true;
  if (o.outcome === 'escalated') return Boolean(o.handoffAction && o.handoffAction !== 'none');
  return false;
}

/** Compute the per-clinic metrics over all recorded outcomes (synthetic in POC). */
export async function getClinicDashboard(store: Store, clinicId: string, recentLimit = 25): Promise<ClinicDashboardMetrics> {
  const outcomes = await store.listClinicOutcomesForClinic(clinicId);
  const notifications = await store.listClinicNotificationsForClinic(clinicId);

  const total = outcomes.length;
  const booked = outcomes.filter((o) => o.outcome === 'booked');
  const noSlot = outcomes.filter((o) => o.outcome === 'no_slot');
  const escalated = outcomes.filter((o) => o.outcome === 'escalated');
  const afterHours = outcomes.filter((o) => o.afterHours === true);
  const afterHoursCaptured = afterHours.filter(isCaptured);
  const bookedWithEvent = booked.filter((o) => Boolean(o.eventId));
  const confirmationsSent = outcomes.filter(
    (o) => o.confirmationStatus === 'sent' || o.confirmationStatus === 'partial',
  );

  return {
    clinicId,
    totalCalls: total,
    booked: booked.length,
    noSlot: noSlot.length,
    escalated: escalated.length,
    bookingRate: rate(booked.length, total),
    escalationRate: rate(escalated.length, total),
    noSlotRate: rate(noSlot.length, total),
    bookingAccuracy: rate(bookedWithEvent.length, booked.length),
    afterHoursTotal: afterHours.length,
    afterHoursCaptured: afterHoursCaptured.length,
    afterHoursDropped: afterHours.length - afterHoursCaptured.length,
    confirmationsSent: confirmationsSent.length,
    notificationsBlocked: notifications.filter((n) => n.status === 'blocked').length,
    recent: outcomes.slice(0, recentLimit),
  };
}
