/**
 * SAU-301 (Phase 2 · WS-B) — multi-clinic tenancy + ops dashboard (logic).
 *
 * Exercises the tenancy service (create / list / switch active / membership gate)
 * and the per-clinic dashboard read-model (outcomes → ROI metrics) against the
 * in-memory store. DB-layer RLS isolation (non-superuser, no cross-clinic leak) is
 * proven separately against a real Postgres in clinic-tenancy-rls.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import {
  createClinicForUser,
  listClinics,
  setActiveClinic,
  resolveActiveClinicId,
  getClinicSwitcherView,
  TenancyError,
} from '@/services/clinic-tenancy';
import { getClinicDashboard } from '@/services/clinic-dashboard';
import type { ClinicOutcomeRecord } from '@/db/store';

async function mkUser(store: MemoryStore, email: string): Promise<string> {
  const u = await store.createUser({ email, passwordHash: 'x', displayName: email });
  return u.id;
}

function outcome(over: Partial<ClinicOutcomeRecord> & { sessionId: string; clinicId: string }): ClinicOutcomeRecord {
  return {
    scenarioId: 'sc-1',
    userId: null,
    outcome: 'booked',
    eventId: null,
    eventLink: null,
    doctorId: null,
    doctorName: null,
    slotStart: null,
    slotEnd: null,
    calendar: 'Simulated calendar',
    simulated: true,
    intake: {},
    ...over,
  };
}

test('tenancy: create → list → switch active, membership-gated', async () => {
  const store = new MemoryStore();
  const op = await mkUser(store, 'op@demo.test');

  const a = await createClinicForUser(store, op, 'Northgate Family Health');
  const b = await createClinicForUser(store, op, 'Riverside Family Health');

  const clinics = await listClinics(store, op);
  assert.equal(clinics.length, 2);

  // Newly created clinic becomes active.
  assert.equal(await resolveActiveClinicId(store, op, null), b.id);

  // Switch back to A.
  await setActiveClinic(store, op, a.id);
  assert.equal(await resolveActiveClinicId(store, op, null), a.id);

  const view = await getClinicSwitcherView(store, op, a.id);
  assert.equal(view.clinics.find((c) => c.id === a.id)?.active, true);
  assert.equal(view.clinics.find((c) => c.id === b.id)?.active, false);

  // A different operator cannot switch to a clinic they don't belong to.
  const other = await mkUser(store, 'other@demo.test');
  await assert.rejects(() => setActiveClinic(store, other, a.id), (e: unknown) => e instanceof TenancyError && (e as TenancyError).status === 403);
});

test('tenancy: a user only sees clinics they are a member of', async () => {
  const store = new MemoryStore();
  const op1 = await mkUser(store, 'op1@demo.test');
  const op2 = await mkUser(store, 'op2@demo.test');
  await createClinicForUser(store, op1, 'Clinic One');
  await createClinicForUser(store, op2, 'Clinic Two');

  assert.deepEqual((await listClinics(store, op1)).map((c) => c.name), ['Clinic One']);
  assert.deepEqual((await listClinics(store, op2)).map((c) => c.name), ['Clinic Two']);
});

test('dashboard: aggregates outcomes into ROI metrics, scoped to one clinic', async () => {
  const store = new MemoryStore();
  const op = await mkUser(store, 'metrics@demo.test');
  const a = await createClinicForUser(store, op, 'Metrics Clinic');
  const b = await createClinicForUser(store, op, 'Other Clinic');

  // Clinic A: 5 calls — 3 booked (2 with a real event), 1 no_slot, 1 escalated
  // after-hours with a voicemail handoff (captured).
  await store.recordClinicOutcome(outcome({ sessionId: 's1', clinicId: a.id, outcome: 'booked', eventId: 'evt-1', confirmationStatus: 'sent' }));
  await store.recordClinicOutcome(outcome({ sessionId: 's2', clinicId: a.id, outcome: 'booked', eventId: 'evt-2', confirmationStatus: 'sent' }));
  await store.recordClinicOutcome(outcome({ sessionId: 's3', clinicId: a.id, outcome: 'booked', eventId: null }));
  await store.recordClinicOutcome(outcome({ sessionId: 's4', clinicId: a.id, outcome: 'no_slot' }));
  await store.recordClinicOutcome(outcome({ sessionId: 's5', clinicId: a.id, outcome: 'escalated', afterHours: true, escalationReason: 'unresolved', handoffAction: 'voicemail' }));

  // Clinic B has its own outcome — must NOT bleed into A's metrics.
  await store.recordClinicOutcome(outcome({ sessionId: 's6', clinicId: b.id, outcome: 'booked', eventId: 'evt-x' }));

  const m = await getClinicDashboard(store, a.id);
  assert.equal(m.totalCalls, 5);
  assert.equal(m.booked, 3);
  assert.equal(m.noSlot, 1);
  assert.equal(m.escalated, 1);
  assert.equal(m.bookingAccuracy, 0.667); // 2 of 3 bookings carry a real calendar event id
  assert.equal(m.afterHoursTotal, 1);
  assert.equal(m.afterHoursCaptured, 1);
  assert.equal(m.afterHoursDropped, 0);
  assert.equal(m.confirmationsSent, 2);
  assert.equal(m.recent.length, 5);

  // Isolation at the read-model: B's single booking is the only thing B sees.
  const mb = await getClinicDashboard(store, b.id);
  assert.equal(mb.totalCalls, 1);
  assert.equal(mb.booked, 1);
});
