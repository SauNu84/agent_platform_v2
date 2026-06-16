/**
 * SAU-300 (Phase 2 · WS-A) — no-code clinic self-service authoring.
 *
 * Proves the two halves of the feature:
 *  1. the configurable RULES engine (services + durations, provider↔service
 *     matching, buffers, lead time, max bookings/day) — all enforced in the pure
 *     domain layer, never the prompt;
 *  2. the per-clinic config service round-trips through the RLS-isolated
 *     user_setting store and the booking tools honor it (e.g. a call refuses an
 *     out-of-hours slot, respects a service duration, and won't double-book under
 *     a custom clinic).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOpenSlots,
  validateBooking,
  findService,
  doctorOffersService,
  resolveDurationMinutes,
  type ClinicConfig,
} from '@/domain/clinic';
import { MockCalendarAdapter } from '@/services/calendar/mock-calendar';
import { checkAvailability, createAppointment } from '@/services/clinic-booking';
import { MemoryStore } from '@/db/memory-store';
import {
  saveClinicConfig,
  getClinicConfig,
  getClinicConfigView,
  clearClinicConfig,
  ClinicConfigError,
} from '@/services/clinic-config';

const DAY = 86_400_000;

/** A small authored clinic used across the rule tests (Mon–Fri 09–17, two services). */
const CFG: ClinicConfig = {
  name: 'Northgate Family Health',
  timezone: 'America/New_York',
  hours: [null, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 1020 }, null],
  slotMinutes: 30,
  doctors: [
    { id: 'dr-a', name: 'Dr. Alice', specialty: 'Family', serviceIds: ['svc-physical', 'svc-quick'] },
    { id: 'dr-b', name: 'Dr. Bob', specialty: 'Peds', serviceIds: ['svc-quick'] },
  ],
  insuranceAccepted: ['Aetna'],
  services: [
    { id: 'svc-physical', name: 'Annual physical', durationMinutes: 60 },
    { id: 'svc-quick', name: 'Quick consult', durationMinutes: 30 },
  ],
  bufferMinutes: 15,
  leadTimeMinutes: 120,
  maxPerDay: 2,
};

/** A deterministic open weekday at 09:00Z for CFG. */
function open9amZ(): number {
  let ms = Date.parse('2026-06-15T09:00:00Z');
  while (!CFG.hours[new Date(ms).getUTCDay()]) ms += DAY;
  return ms;
}

test('findService / doctorOffersService / resolveDurationMinutes', () => {
  const physical = findService(CFG, 'Annual physical');
  assert.equal(physical?.id, 'svc-physical');
  assert.equal(findService(CFG, 'nope'), null);
  assert.equal(resolveDurationMinutes(CFG, physical), 60);
  assert.equal(resolveDurationMinutes(CFG, null), 30); // default slot length
  assert.equal(doctorOffersService(CFG.doctors[0], physical), true);
  assert.equal(doctorOffersService(CFG.doctors[1], physical), false); // Bob doesn't do physicals
});

test('computeOpenSlots honors service duration + provider filter', () => {
  const from = open9amZ();
  const to = from + DAY;
  const physical = findService(CFG, 'svc-physical');
  // Only Dr. Alice offers physicals → only her slots, each 60 min long.
  const slots = computeOpenSlots(CFG, { fromMs: from, toMs: to }, [], null, 100, { service: physical });
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => s.doctorId === 'dr-a'));
  assert.ok(slots.every((s) => (s.endMs - s.startMs) / 60000 === 60));
});

test('lead time blocks slots/bookings inside the notice window', () => {
  const from = open9amZ();
  // "now" = 30 min before opening; lead time 120 min ⇒ the 09:00 slot is too soon.
  const now = from - 30 * 60_000;
  const slots = computeOpenSlots(CFG, { fromMs: from, toMs: from + DAY }, [], 'dr-a', 100, { nowMs: now });
  assert.ok(slots.every((s) => s.startMs >= now + 120 * 60_000));

  const tooSoon = validateBooking(CFG, { doctor: 'dr-a', slotStartIso: new Date(from).toISOString() }, [], { nowMs: now });
  assert.equal(tooSoon.reason, 'lead_time');
  // Far enough out (next day same time) → fine.
  const ok = validateBooking(CFG, { doctor: 'dr-a', slotStartIso: new Date(from + DAY).toISOString() }, [], { nowMs: now });
  assert.equal(ok.ok, true);
});

test('buffer expands the double-book window', () => {
  const from = open9amZ();
  // Busy 09:00–09:30; with a 15-min buffer a 09:30 start collides (needs ≥09:45).
  const busy = [{ doctorId: 'dr-a', startMs: from, endMs: from + 30 * 60_000 }];
  const adjacent = validateBooking(CFG, { doctor: 'dr-a', slotStartIso: new Date(from + 30 * 60_000).toISOString() }, busy);
  assert.equal(adjacent.reason, 'double_book');
  // 10:00 (next grid slot) clears the 15-min buffer after the 09:30 end.
  const clear = validateBooking(CFG, { doctor: 'dr-a', slotStartIso: new Date(from + 60 * 60_000).toISOString() }, busy);
  assert.equal(clear.ok, true);
});

test('max bookings/day refuses once the cap is reached', () => {
  const from = open9amZ();
  // Two existing bookings that day for Dr. Bob → his daily cap (2) is hit.
  const busy = [
    { doctorId: 'dr-b', startMs: from, endMs: from + 30 * 60_000 },
    { doctorId: 'dr-b', startMs: from + 2 * 3600_000, endMs: from + 2 * 3600_000 + 30 * 60_000 },
  ];
  const res = validateBooking(CFG, { doctor: 'dr-b', slotStartIso: new Date(from + 4 * 3600_000).toISOString() }, busy);
  assert.equal(res.reason, 'day_full');
});

test('service the provider does not offer is rejected', () => {
  const from = open9amZ();
  const res = validateBooking(CFG, { doctor: 'dr-b', service: 'Annual physical', slotStartIso: new Date(from).toISOString() }, []);
  assert.equal(res.reason, 'service_unavailable');
  const unknown = validateBooking(CFG, { doctor: 'dr-a', service: 'Reiki', slotStartIso: new Date(from).toISOString() }, []);
  assert.equal(unknown.reason, 'unknown_service');
});

test('booking service end-to-end under a custom clinic (duration + double-book)', async () => {
  const cal = new MockCalendarAdapter();
  const now = open9amZ() - 3 * 3600_000; // well before opening so lead time is satisfied
  const deps = { clinic: CFG, calendar: cal, nowMs: now };

  const avail = await checkAvailability({ doctor: 'dr-a', service: 'svc-physical' }, deps);
  assert.ok(avail.slots.length > 0);
  assert.equal(avail.services.length, 2);
  assert.deepEqual(avail.insuranceAccepted, ['Aetna']);
  const slot = avail.slots[0];

  const booked = await createAppointment(
    { patientName: 'Pat Q', doctor: 'dr-a', service: 'svc-physical', slotStart: slot.start, insurance: 'Aetna' },
    deps,
  );
  assert.equal(booked.booked, true);
  if (booked.booked) {
    // 60-minute physical, not the 30-min default.
    assert.equal((Date.parse(booked.end) - Date.parse(booked.start)) / 60000, 60);
  }

  // A second booking that overlaps the buffer is refused.
  const clash = await createAppointment(
    { patientName: 'Sam R', doctor: 'dr-a', service: 'svc-quick', slotStart: slot.start },
    deps,
  );
  assert.equal(clash.booked, false);
});

test('clinic-config service: save → effective config → clear (RLS-isolated store)', async () => {
  const store = new MemoryStore();
  const USER = 'user-1';

  // Nothing authored yet ⇒ effective config is the Phase-0 default.
  const before = await getClinicConfig(store, USER);
  assert.equal(before.name, 'Riverside Family Health');

  await saveClinicConfig(store, USER, {
    name: 'Northgate Family Health',
    timezone: 'America/New_York',
    hours: [null, { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '09:00', close: '16:00' }, null],
    slotMinutes: 30,
    doctors: [{ id: 'dr-a', name: 'Dr. Alice', specialty: 'Family', serviceIds: ['svc-1'] }],
    services: [{ id: 'svc-1', name: 'Annual physical', durationMinutes: 60 }],
    insuranceAccepted: ['Aetna', 'Cigna'],
    afterHours: { mode: 'callback' },
    bufferMinutes: 10,
    leadTimeMinutes: 60,
    maxPerDay: 8,
    greeting: 'Thanks for calling Northgate.',
  });

  const after = await getClinicConfig(store, USER);
  assert.equal(after.name, 'Northgate Family Health');
  assert.equal(after.services?.[0].durationMinutes, 60);
  assert.equal(after.bufferMinutes, 10);
  assert.equal(after.maxPerDay, 8);
  assert.equal(after.afterHours?.mode, 'callback');

  const view = await getClinicConfigView(store, USER);
  assert.equal(view.configured, true);
  assert.equal(view.config.hours[1]?.open, '09:00');

  // Another user is unaffected (own-scoped) — still sees the default.
  const other = await getClinicConfig(store, 'user-2');
  assert.equal(other.name, 'Riverside Family Health');

  await clearClinicConfig(store, USER);
  const reverted = await getClinicConfig(store, USER);
  assert.equal(reverted.name, 'Riverside Family Health');
});

test('clinic-config service rejects invalid input', async () => {
  const store = new MemoryStore();
  await assert.rejects(
    () => saveClinicConfig(store, 'u', { name: '', timezone: 'X', hours: [null, null, null, null, null, null, null], slotMinutes: 30, doctors: [] }),
    ClinicConfigError,
  );
  // close-before-open is a cross-field error.
  await assert.rejects(
    () => saveClinicConfig(store, 'u', {
      name: 'C', timezone: 'America/New_York',
      hours: [null, { open: '17:00', close: '09:00' }, null, null, null, null, null],
      slotMinutes: 30, doctors: [{ id: 'd', name: 'Dr X', specialty: '', serviceIds: [] }],
    }),
    ClinicConfigError,
  );
});
