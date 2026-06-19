import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import {
  track, trackSafe, getFunnelReport, getActivationReport, getRetentionReport, isoWeek,
} from '@/services/product-analytics';
import { PRODUCT_EVENTS, assertPiiFree, PiiViolationError } from '@/domain/analytics-events';
import { createScenarioFromMarkdown } from '@/services/scenarios';

const T0 = Date.parse('2026-06-01T10:00:00.000Z'); // a Monday
const DAY = 86_400_000;
const WEEK = 7 * DAY;

// ── PII guard ────────────────────────────────────────────────────────────────

test('assertPiiFree rejects forbidden keys, free text, emails, and phone-shaped values', () => {
  assert.throws(() => assertPiiFree({ patientName: 'Jane' }), PiiViolationError);
  assert.throws(() => assertPiiFree({ email: 'x@y.com' }), PiiViolationError);
  assert.throws(() => assertPiiFree({ note: 'free text' }), PiiViolationError);
  assert.throws(() => assertPiiFree({ contact: 'jane@clinic.com' }), PiiViolationError); // value is an email
  assert.throws(() => assertPiiFree({ ref: '415 555 1234' }), PiiViolationError);        // phone shape
  assert.throws(() => assertPiiFree({ blob: { nested: 1 } as unknown as string }), PiiViolationError);
  assert.throws(() => assertPiiFree({ long: 'x'.repeat(65) }), PiiViolationError);
  // enums / counts / bools are fine
  assert.doesNotThrow(() => assertPiiFree({ surface: 'voice', turns: 12, booked: true, tier: 'free', x: null }));
});

test('track fails closed on a PII payload and does not persist', async () => {
  const store = new MemoryStore();
  await assert.rejects(
    track(store, { event: PRODUCT_EVENTS.CLINIC_SESSION_COMPLETED, props: { patientName: 'Jane' } }),
    PiiViolationError,
  );
  const rows = await store.queryProductEvents({});
  assert.equal(rows.length, 0, 'nothing should have been written');
});

test('trackSafe swallows a PII rejection (never breaks the product flow)', async () => {
  const store = new MemoryStore();
  await trackSafe(store, { event: PRODUCT_EVENTS.CLINIC_SESSION_COMPLETED, props: { email: 'a@b.com' } });
  assert.equal((await store.queryProductEvents({})).length, 0);
});

test('track derives the archetype from the event-name prefix', async () => {
  const store = new MemoryStore();
  await track(store, { event: PRODUCT_EVENTS.HRM_SESSION_COMPLETED });
  const [row] = await store.queryProductEvents({});
  assert.equal(row.archetype, 'hrm');
});

// ── Funnel ───────────────────────────────────────────────────────────────────

test('clinic funnel computes step + overall conversion over distinct tenants', async () => {
  const store = new MemoryStore();
  // 3 tenants view the demo; 2 start setup; 2 connect calendar; 1 books.
  for (const t of ['c1', 'c2', 'c3']) await track(store, { event: PRODUCT_EVENTS.CLINIC_DEMO_VIEWED, tenantId: t });
  for (const t of ['c1', 'c2']) await track(store, { event: PRODUCT_EVENTS.CLINIC_SETUP_STARTED, tenantId: t });
  for (const t of ['c1', 'c2']) await track(store, { event: PRODUCT_EVENTS.CLINIC_CALENDAR_CONNECTED, tenantId: t });
  // c1 runs two sessions (dedup → counts as 1 tenant) then books
  await track(store, { event: PRODUCT_EVENTS.CLINIC_SESSION_COMPLETED, tenantId: 'c1' });
  await track(store, { event: PRODUCT_EVENTS.CLINIC_SESSION_COMPLETED, tenantId: 'c1' });
  await track(store, { event: PRODUCT_EVENTS.CLINIC_BOOKING_COMPLETED, tenantId: 'c1' });

  const funnel = await getFunnelReport(store, 'clinic');
  assert.equal(funnel.cohort, 'tenant');
  assert.deepEqual(funnel.steps.map((s) => s.reached), [3, 2, 2, 1, 1]);
  assert.equal(funnel.steps[1].stepConversion, 0.6667); // 2/3
  assert.equal(funnel.steps[2].stepConversion, 1);       // 2/2
  assert.equal(funnel.steps[4].overallConversion, 0.3333); // 1/3 booked
  // events outside the journey / null cohort are ignored
});

test('funnel ignores events with a null cohort key', async () => {
  const store = new MemoryStore();
  await track(store, { event: PRODUCT_EVENTS.CLINIC_DEMO_VIEWED, tenantId: null });
  const funnel = await getFunnelReport(store, 'clinic');
  assert.equal(funnel.steps[0].reached, 0);
});

// ── Activation ───────────────────────────────────────────────────────────────

test('activation report reports activation + value rates', async () => {
  const store = new MemoryStore();
  for (const t of ['c1', 'c2', 'c3', 'c4']) await track(store, { event: PRODUCT_EVENTS.CLINIC_DEMO_VIEWED, tenantId: t });
  for (const t of ['c1', 'c2']) await track(store, { event: PRODUCT_EVENTS.CLINIC_CALENDAR_CONNECTED, tenantId: t });
  await track(store, { event: PRODUCT_EVENTS.CLINIC_BOOKING_COMPLETED, tenantId: 'c1' });

  const a = await getActivationReport(store, 'clinic');
  assert.equal(a.entered, 4);
  assert.equal(a.activated, 2);
  assert.equal(a.activationRate, 0.5);
  assert.equal(a.realizedValue, 1);
  assert.equal(a.valueRate, 0.25);
});

// ── Retention ────────────────────────────────────────────────────────────────

test('weekly retention measures W→W+1 return of active cohort entities', async () => {
  const store = new MemoryStore();
  // Week 0: a1, a2 active. Week 1: a1 returns, a3 new. Week 2: a1 again.
  await track(store, { event: PRODUCT_EVENTS.HRM_SESSION_COMPLETED, actorId: 'a1', ts: T0 });
  await track(store, { event: PRODUCT_EVENTS.HRM_SESSION_COMPLETED, actorId: 'a2', ts: T0 });
  await track(store, { event: PRODUCT_EVENTS.HRM_SESSION_COMPLETED, actorId: 'a1', ts: T0 + WEEK });
  await track(store, { event: PRODUCT_EVENTS.HRM_SESSION_COMPLETED, actorId: 'a3', ts: T0 + WEEK });
  await track(store, { event: PRODUCT_EVENTS.HRM_SESSION_COMPLETED, actorId: 'a1', ts: T0 + 2 * WEEK });

  const r = await getRetentionReport(store, 'hrm');
  assert.equal(r.weeks.length, 3);
  // Week 0: 2 active (a1,a2), only a1 returns next week → 1/2
  assert.equal(r.weeks[0].active, 2);
  assert.equal(r.weeks[0].retainedNextWeek, 1);
  assert.equal(r.weeks[0].retentionRate, 0.5);
  // Week 1: 2 active (a1,a3), only a1 returns → 1/2
  assert.equal(r.weeks[1].retentionRate, 0.5);
  // Week 2: last week, no successor → 0
  assert.equal(r.weeks[2].retainedNextWeek, 0);
});

test('isoWeek buckets timestamps in the same week together', () => {
  const monday = isoWeek('2026-06-01T00:00:00Z');
  const sunday = isoWeek('2026-06-07T23:59:00Z');
  assert.equal(monday, sunday);
  assert.notEqual(monday, isoWeek('2026-06-08T00:00:00Z'));
});

// ── Wired seam: scenario creation emits agent.created ─────────────────────────

const SCENARIO_MD = `---
id: wired-agent
name: Wired Agent
persona: be helpful
rubric:
  - { topic: greeting, weight: 100 }
visibility: public
---
`;

test('creating a scenario emits a PII-free platform.agent.created event', async () => {
  const store = new MemoryStore();
  await createScenarioFromMarkdown(store, SCENARIO_MD, {}, { ownerUserId: 'owner-1' });
  const rows = await store.queryProductEvents({ archetype: 'platform' });
  const created = rows.find((r) => r.event === PRODUCT_EVENTS.AGENT_CREATED);
  assert.ok(created, 'agent.created event should be emitted');
  assert.equal(created!.actorId, 'owner-1');
  assert.equal(created!.props.topology, 'single-agent');
  assert.equal(created!.scenarioId !== null, true);
});

test('querying by window and event name filters correctly', async () => {
  const store = new MemoryStore();
  await track(store, { event: PRODUCT_EVENTS.AGENT_CREATED, ts: T0 });
  await track(store, { event: PRODUCT_EVENTS.AGENT_CREATED, ts: T0 + WEEK });
  const since = new Date(T0 + DAY).toISOString();
  const rows = await store.queryProductEvents({ events: [PRODUCT_EVENTS.AGENT_CREATED], since });
  assert.equal(rows.length, 1);
});
