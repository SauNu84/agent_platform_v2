/**
 * SAU-359 (WS5 §6) — Clinic TOP-OF-FUNNEL event wiring.
 *
 * The upper half of the clinic funnel (demo.viewed → setup.started →
 * calendar.connected ★). The bottom/value half is covered by clinic-booking.test.ts
 * (SAU-358). These tests prove the three emit helpers:
 *   - record the right taxonomy event name + archetype + surface;
 *   - scope to the tenant (clinicId → product_event.tenant_id);
 *   - carry ONLY enum/count/bool props that CLEAR the track() PII guard — i.e.
 *     the event is not silently dropped (the guard fails closed), which guards
 *     against the forbidden-token traps ("phone…" / raw email-shaped calendar id).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import {
  emitClinicDemoViewed,
  emitClinicSetupStarted,
  emitClinicCalendarConnected,
} from '@/services/clinic-funnel';
import { assertPiiFree } from '@/domain/analytics-events';

const CLINIC = '00000000-0000-0000-0000-0000000000c1';
const ACTOR = '00000000-0000-0000-0000-0000000000a1';

test('SAU-359: top-of-funnel helpers emit the 3 PII-free clinic funnel events, tenant-scoped', async () => {
  const store = new MemoryStore();

  await emitClinicDemoViewed(store, { actorId: ACTOR, clinicId: CLINIC });
  await emitClinicSetupStarted(store, {
    actorId: ACTOR,
    clinicId: CLINIC,
    calendarConnected: false,
    oauthConfigured: true,
    clinicConfigured: true,
    numbersConfigured: false,
  });
  // A custom (email-shaped) calendar id must be reduced to the enum 'custom',
  // never emitted raw — else the PII guard would drop the activation event.
  await emitClinicCalendarConnected(store, {
    actorId: ACTOR,
    clinicId: CLINIC,
    calendarId: 'clinic@group.calendar.google.com',
    fromDemoConfig: true,
  });

  const events = await store.queryProductEvents({ archetype: 'clinic', tenantId: CLINIC });
  const names = events.map((e) => e.event);

  // All three persisted (none dropped by the fail-closed PII guard).
  assert.ok(names.includes('clinic.demo.viewed'), 'demo.viewed emitted');
  assert.ok(names.includes('clinic.setup.started'), 'setup.started emitted');
  assert.ok(names.includes('clinic.calendar.connected'), 'calendar.connected (activation ★) emitted');

  for (const e of events) {
    assert.equal(e.surface, 'web');
    assert.equal(e.tenantId, CLINIC, 'scoped to the clinic tenant');
    assert.equal(e.actorId, ACTOR);
    // Belt-and-braces: re-run the guard over what was actually stored.
    assert.doesNotThrow(() => assertPiiFree(e.props as Record<string, string | number | boolean | null>));
  }

  // The activation event carries the enum target, NOT the raw email-shaped id.
  const activation = events.find((e) => e.event === 'clinic.calendar.connected')!;
  assert.equal(activation.props.target, 'custom');
  assert.equal(activation.props.provider, 'google');
  assert.equal(activation.props.from_demo_config, true);

  // A 'primary' calendar id maps to the 'primary' target enum.
  const store2 = new MemoryStore();
  await emitClinicCalendarConnected(store2, {
    actorId: ACTOR,
    clinicId: CLINIC,
    calendarId: 'primary',
    fromDemoConfig: false,
  });
  const [primary] = await store2.queryProductEvents({ archetype: 'clinic', tenantId: CLINIC });
  assert.equal(primary.props.target, 'primary');
});

test('SAU-359: a clinic-less operator emits a platform-scoped (null-tenant) demo view', async () => {
  const store = new MemoryStore();
  await emitClinicDemoViewed(store, { actorId: ACTOR, clinicId: null });
  // tenant_id IS NULL → still recorded (RLS allows it), but the per-tenant funnel
  // cohort (cohort='tenant') simply won't count a null tenant.
  const events = await store.queryProductEvents({ archetype: 'clinic' });
  const viewed = events.find((e) => e.event === 'clinic.demo.viewed')!;
  assert.equal(viewed.tenantId, null);
  assert.equal(viewed.props.has_clinic, false);
});
