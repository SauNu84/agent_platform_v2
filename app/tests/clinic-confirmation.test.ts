import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSmsConfirmation,
  buildEmailConfirmation,
  findPhiLeaks,
  type BookingPhi,
} from '@/services/clinic-confirmation';

// A representative synthetic booking, used to prove none of these PHI fields
// appear in the generic confirmation bodies.
const PHI: BookingPhi = {
  patientName: 'Jordan Rivera',
  dob: '1984-07-22',
  reason: 'persistent migraine',
  doctorName: 'Dr. Amara Chen',
  startIso: '2026-06-18T14:30:00.000Z',
};

const INPUT = {
  reference: 'evt_abc123',
  portalUrl: 'https://portal.example.com/b/evt_abc123',
  clinicName: 'Riverside Family Health',
};

test('SMS confirmation contains the reference + portal link and no PHI', () => {
  const msg = buildSmsConfirmation(INPUT);
  assert.equal(msg.channel, 'sms');
  assert.match(msg.body, /evt_abc123/);
  assert.match(msg.body, /portal\.example\.com/);
  assert.deepEqual(findPhiLeaks(msg.body, PHI), []);
});

test('Email confirmation has a generic subject + body with no PHI; details deferred to portal', () => {
  const msg = buildEmailConfirmation(INPUT);
  assert.equal(msg.channel, 'email');
  assert.equal(msg.subject, 'Your appointment is confirmed');
  assert.match(msg.body, /evt_abc123/);
  assert.match(msg.body, /portal\.example\.com/);
  assert.match(msg.body, /secure (patient )?portal/i);
  assert.deepEqual(findPhiLeaks(msg.body, PHI), []);
});

test('findPhiLeaks flags a body that leaks the patient name or appointment time', () => {
  const leaky = `Hi Jordan Rivera, your visit with Dr. Amara Chen is confirmed.`;
  const leaks = findPhiLeaks(leaky, PHI);
  assert.ok(leaks.includes('patientName'));
  assert.ok(leaks.includes('doctorName'));
});

test('templates fall back to a neutral clinic label when none is provided', () => {
  const sms = buildSmsConfirmation({ reference: 'r1', portalUrl: 'https://x.test/r1' });
  assert.match(sms.body, /Your clinic/);
  const email = buildEmailConfirmation({ reference: 'r1', portalUrl: 'https://x.test/r1' });
  assert.match(email.body, /your clinic/);
});
