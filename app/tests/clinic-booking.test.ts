/**
 * SAU-267 — Clinic Intake & Booking (Phase 0) action-taking agent.
 *
 * Covers the "last mile" that turns a roleplay into a real outcome:
 *  - clinic RULES live in the tool/domain, not the prompt (hours, slot length,
 *    no double-book) — enforced regardless of args;
 *  - the calendar adapter seam (mock) creates real event ids + reports busy;
 *  - the booking service rejects rule violations and books valid slots;
 *  - the post-session intake extractor produces a validated JSON record;
 *  - the task-completion outcome (booked / no_slot / escalated) is derived from
 *    the transcript and persisted alongside the session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CLINIC, computeOpenSlots, validateBooking, findDoctor, isInsuranceAccepted } from '@/domain/clinic';
import { MockCalendarAdapter } from '@/services/calendar/mock-calendar';
import { checkAvailability, createAppointment } from '@/services/clinic-booking';
import { HeuristicIntakeExtractor } from '@/intake/extractor';
import { deriveOutcome, isClinicScenario, finalizeClinicSession } from '@/services/clinic-session';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';

const DAY = 86_400_000;

/** A deterministic open clinic weekday at 09:00Z (the clinic's opening minute). */
function openDay9amZ(): number {
  let ms = Date.parse('2026-06-15T09:00:00Z');
  while (!DEFAULT_CLINIC.hours[new Date(ms).getUTCDay()]) ms += DAY;
  return ms;
}

test('clinic config exposes the two seeded doctors + insurance list', () => {
  assert.equal(DEFAULT_CLINIC.doctors.length, 2);
  assert.ok(findDoctor(DEFAULT_CLINIC, 'Chen'));
  assert.ok(findDoctor(DEFAULT_CLINIC, 'dr-okafor'));
  assert.equal(findDoctor(DEFAULT_CLINIC, 'Dr. Nobody'), null);
  assert.equal(isInsuranceAccepted(DEFAULT_CLINIC, 'Aetna'), true);
  assert.equal(isInsuranceAccepted(DEFAULT_CLINIC, 'Pretend Health'), false);
});

test('computeOpenSlots yields in-hours, grid-aligned slots and skips busy ones', () => {
  const from = openDay9amZ();
  const to = from + DAY;
  const slots = computeOpenSlots(DEFAULT_CLINIC, { fromMs: from, toMs: to }, [], 'dr-chen', 100);
  assert.ok(slots.length > 0);
  // First slot is exactly at opening.
  assert.equal(slots[0].startMs, from);
  // 30-min grid; all within the day's open window.
  for (const s of slots) {
    assert.equal((s.endMs - s.startMs) / 60000, DEFAULT_CLINIC.slotMinutes);
    assert.equal((s.startMs - from) % (DEFAULT_CLINIC.slotMinutes * 60000), 0);
  }
  // Mark the first slot busy → it disappears.
  const busy = [{ doctorId: 'dr-chen', startMs: slots[0].startMs, endMs: slots[0].endMs }];
  const after = computeOpenSlots(DEFAULT_CLINIC, { fromMs: from, toMs: to }, busy, 'dr-chen', 100);
  assert.ok(!after.some((s) => s.startMs === from));
});

test('validateBooking enforces hours, alignment, doctor, double-book', () => {
  const from = openDay9amZ();
  // valid
  assert.equal(validateBooking(DEFAULT_CLINIC, { doctor: 'dr-chen', slotStartIso: new Date(from).toISOString() }, []).ok, true);
  // before opening (08:00Z) → outside hours
  assert.equal(validateBooking(DEFAULT_CLINIC, { doctor: 'dr-chen', slotStartIso: new Date(from - 3600_000).toISOString() }, []).reason, 'outside_hours');
  // misaligned (09:07) → bad slot
  assert.equal(validateBooking(DEFAULT_CLINIC, { doctor: 'dr-chen', slotStartIso: new Date(from + 7 * 60000).toISOString() }, []).reason, 'bad_slot');
  // unknown doctor
  assert.equal(validateBooking(DEFAULT_CLINIC, { doctor: 'Dr. Who', slotStartIso: new Date(from).toISOString() }, []).reason, 'unknown_doctor');
  // double-book
  const busy = [{ doctorId: 'dr-chen', startMs: from, endMs: from + 30 * 60000 }];
  assert.equal(validateBooking(DEFAULT_CLINIC, { doctor: 'dr-chen', slotStartIso: new Date(from).toISOString() }, busy).reason, 'double_book');
  // a closed day (Sunday) → outside hours
  const sunday = (() => { let ms = openDay9amZ(); while (new Date(ms).getUTCDay() !== 0) ms += DAY; return ms; })();
  assert.equal(validateBooking(DEFAULT_CLINIC, { doctor: 'dr-chen', slotStartIso: new Date(sunday).toISOString() }, []).reason, 'outside_hours');
});

test('mock calendar creates real event ids and reports busy', async () => {
  const cal = new MockCalendarAdapter();
  const start = openDay9amZ();
  const evt = await cal.createEvent({ doctorId: 'dr-chen', summary: 'Test', startMs: start, endMs: start + 1800_000 });
  assert.ok(evt.id.startsWith('sim-evt-'));
  assert.equal(cal.simulated, true);
  const busy = await cal.listBusy({ fromMs: start - 1000, toMs: start + 3600_000 }, 'dr-chen');
  assert.equal(busy.length, 1);
});

test('booking service: check → book → double-book rejection (rules in the tool)', async () => {
  const cal = new MockCalendarAdapter();
  const now = openDay9amZ();
  const deps = { calendar: cal, nowMs: now };

  const avail = await checkAvailability({ doctor: 'dr-chen' }, deps);
  assert.ok(avail.slots.length > 0);
  assert.equal(avail.simulated, true);
  const slot = avail.slots[0];

  const booked = await createAppointment(
    { patientName: 'Jordan Patel', doctor: 'dr-chen', slotStart: slot.start, reason: 'cough', insurance: 'Aetna' },
    deps,
  );
  assert.equal(booked.booked, true);
  if (booked.booked) {
    assert.ok(booked.eventId);
    assert.equal(booked.insuranceAccepted, true);
  }

  // Same slot again → the tool re-reads busy and refuses (no double-book).
  const again = await createAppointment({ patientName: 'Sam Lee', doctor: 'dr-chen', slotStart: slot.start, reason: 'checkup' }, deps);
  assert.equal(again.booked, false);
  if (!again.booked) assert.equal(again.reason, 'double_book');
});

test('booking service rejects out-of-hours request even if the model asks', async () => {
  const cal = new MockCalendarAdapter();
  const now = openDay9amZ();
  const res = await createAppointment(
    { patientName: 'Night Owl', doctor: 'dr-chen', slotStart: new Date(now - 3600_000).toISOString(), reason: 'late' },
    { calendar: cal, nowMs: now },
  );
  assert.equal(res.booked, false);
  if (!res.booked) assert.equal(res.reason, 'outside_hours');
});

test('booking service requires a patient name', async () => {
  const res = await createAppointment({ doctor: 'dr-chen', slotStart: new Date(openDay9amZ()).toISOString() }, { calendar: new MockCalendarAdapter(), nowMs: openDay9amZ() });
  assert.equal(res.booked, false);
  if (!res.booked) assert.equal(res.reason, 'missing_fields');
});

test('heuristic intake extractor merges booking args + transcript scan', async () => {
  const ex = new HeuristicIntakeExtractor();
  const rec = await ex.extract({
    turns: [
      { role: 'agent', text: 'Hi, this is Robin at Riverside.', at: 1 },
      { role: 'user', text: 'My name is Jordan Patel and I have Aetna. My number is 555-123-4567.', at: 2 },
    ],
    toolCalls: [
      { name: 'create_appointment', args: { patientName: 'Jordan Patel', doctor: 'dr-chen', reason: 'cough', dob: '1990-03-04', insurance: 'Aetna', slotStart: '2026-06-15T09:00:00.000Z' }, result: { booked: true }, at: 3 },
    ],
  });
  assert.equal(rec.patientName, 'Jordan Patel');
  assert.equal(rec.dob, '1990-03-04');
  assert.equal(rec.reasonForVisit, 'cough');
  assert.equal(rec.insurance, 'Aetna');
  assert.equal(rec.phone, '555-123-4567');
  assert.deepEqual(rec.preferredTimes, ['2026-06-15T09:00:00.000Z']);

  // Regression: an ISO DOB (8 digits) must NOT be mistaken for a phone (≥10 digits).
  const noPhone = await ex.extract({
    turns: [{ role: 'user', text: 'I was born 1990-03-04.', at: 1 }],
    toolCalls: [],
  });
  assert.equal(noPhone.phone, null);
  assert.equal(noPhone.dob, '1990-03-04');
});

test('deriveOutcome: booked / no_slot / escalated', () => {
  assert.equal(deriveOutcome([{ name: 'create_appointment', args: {}, result: { booked: true, eventId: 'sim-evt-1' }, at: 1 }]).outcome, 'booked');
  assert.equal(deriveOutcome([{ name: 'check_availability', args: {}, result: { slots: [] }, at: 1 }]).outcome, 'no_slot');
  assert.equal(deriveOutcome([{ name: 'create_appointment', args: {}, result: { booked: false, reason: 'double_book' }, at: 1 }]).outcome, 'no_slot');
  assert.equal(deriveOutcome([]).outcome, 'escalated');
});

test('isClinicScenario detects the booking tools', async () => {
  const store = new MemoryStore();
  const clinic = await createScenarioFromMarkdown(
    store,
    `---\nid: t-clinic\nname: T\npersona: be Robin\nvisibility: public\ntools: [check_availability, create_appointment]\n---\n`,
    { repoPath: 'x.md', revision: null },
  );
  const plain = await createScenarioFromMarkdown(
    store,
    `---\nid: t-plain\nname: T2\npersona: be a coach\nvisibility: public\n---\n`,
    { repoPath: 'y.md', revision: null },
  );
  assert.equal(isClinicScenario(clinic.scenario), true);
  assert.equal(isClinicScenario(plain.scenario), false);
});

test('finalizeClinicSession persists outcome + intake against a session', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(
    store,
    `---\nid: fin-clinic\nname: Fin\npersona: be Robin\nvisibility: public\ntools: [check_availability, create_appointment]\n---\n`,
    { repoPath: 'z.md', revision: null },
  );
  const session = await store.createSession({ scenarioId: scenario.id, userId: null, vendor: 'mock' });
  const transcript = {
    turns: [{ role: 'user' as const, text: 'I am Jordan Patel, book me with Dr Chen', at: 1 }],
    toolCalls: [
      { name: 'check_availability', args: { doctor: 'dr-chen' }, result: { slots: [{ start: '2026-06-15T09:00:00.000Z' }] }, at: 2 },
      { name: 'create_appointment', args: { patientName: 'Jordan Patel', doctor: 'dr-chen', reason: 'cough', slotStart: '2026-06-15T09:00:00.000Z' }, result: { booked: true, eventId: 'sim-evt-x', doctorName: 'Dr. Amara Chen', start: '2026-06-15T09:00:00.000Z', simulated: true, calendar: 'Simulated calendar (sandbox)' }, at: 3 },
    ],
  };
  const rec = await finalizeClinicSession({ store, scenario, sessionId: session.id, userId: null, transcript });
  assert.equal(rec.outcome, 'booked');
  assert.equal(rec.eventId, 'sim-evt-x');
  assert.equal((rec.intake as { patientName?: string }).patientName, 'Jordan Patel');
  const fetched = await store.getClinicOutcome(session.id);
  assert.equal(fetched?.outcome, 'booked');
});
