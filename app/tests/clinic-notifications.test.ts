import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Force the deterministic mock transports (no creds, no network) for the whole file.
process.env.NOTIFY_PROVIDER = 'mock';
delete process.env.NOTIFY_TEST_SMS;
delete process.env.NOTIFY_TEST_EMAIL;
delete process.env.CLINIC_NOTIFY_SMS;
delete process.env.CLINIC_NOTIFY_EMAIL;

import { resolveSmsAdapter, resolveEmailAdapter, mockOutbox, __resetMockOutbox } from '@/services/notifications';
import { dispatchBookingConfirmations, dispatchEscalationNotice, maskRecipient } from '@/services/clinic-notify';

beforeEach(() => __resetMockOutbox());

test('resolver fails soft to the simulated mock transport when no vendor keys are set', () => {
  assert.equal(resolveSmsAdapter().simulated, true);
  assert.equal(resolveEmailAdapter().simulated, true);
  assert.equal(resolveSmsAdapter().channel, 'sms');
  assert.equal(resolveEmailAdapter().channel, 'email');
});

test('maskRecipient never reveals the full phone/email (contact PHI)', () => {
  assert.equal(maskRecipient('+1 (415) 555-2671'), '***-***-2671');
  assert.equal(maskRecipient('jordan.rivera@example.com'), 'j***@example.com');
});

test('successful booking sends patient SMS + email; bodies carry the reference + portal link and zero PHI', async () => {
  const deliveries = await dispatchBookingConfirmations({
    reference: 'evt_xyz789',
    clinicName: 'Riverside Family Health',
    contacts: { patientPhone: '+14155552671', patientEmail: 'patient@example.com' },
    phi: { patientName: 'Jordan Rivera', dob: '1984-07-22', reason: 'migraine', doctorName: 'Dr. Amara Chen', startIso: '2026-06-18T14:30:00Z' },
  });
  const patient = deliveries.filter((d) => d.audience === 'patient');
  assert.equal(patient.length, 2);
  assert.ok(patient.every((d) => d.status === 'sent'));
  assert.ok(patient.every((d) => d.simulated));
  // Recipients are masked in the delivery record.
  assert.ok(patient.every((d) => /\*\*\*/.test(d.recipientMasked)));
  // The actual sent bodies contain the reference + portal and NO PHI.
  const bodies = mockOutbox().map((m) => `${m.subject ?? ''}\n${m.body}`).join('\n');
  assert.match(bodies, /evt_xyz789/);
  assert.match(bodies, /portal/i);
  assert.doesNotMatch(bodies, /Jordan Rivera/);
  assert.doesNotMatch(bodies, /migraine/);
  assert.doesNotMatch(bodies, /Amara Chen/);
});

test('clinic notification is skipped when no clinic recipient is configured', async () => {
  const deliveries = await dispatchBookingConfirmations({
    reference: 'evt_1',
    contacts: { patientPhone: '+14155550000' },
    phi: {},
  });
  // patient sms sent, patient email skipped (no email), no clinic rows.
  assert.ok(deliveries.some((d) => d.audience === 'patient' && d.channel === 'sms' && d.status === 'sent'));
  assert.ok(deliveries.some((d) => d.audience === 'patient' && d.channel === 'email' && d.status === 'skipped'));
  assert.equal(deliveries.filter((d) => d.audience === 'clinic').length, 0);
});

test('fail-CLOSED: a body that would leak PHI is blocked, not transmitted', async () => {
  // Engineer a leak: the patient name equals the (opaque) reference, so it appears
  // in the body. The guard must refuse to send rather than leak it.
  const deliveries = await dispatchBookingConfirmations({
    reference: 'SECRETNAME',
    contacts: { patientPhone: '+14155551111' },
    phi: { patientName: 'SECRETNAME' },
  });
  const sms = deliveries.find((d) => d.audience === 'patient' && d.channel === 'sms');
  assert.equal(sms?.status, 'blocked');
  assert.match(sms?.error ?? '', /phi_leak/);
  // Nothing was actually handed to the transport.
  assert.equal(mockOutbox().length, 0);
});

test('escalation notice to the clinic is PHI-free and goes only to configured clinic contacts', async () => {
  process.env.CLINIC_NOTIFY_SMS = '+14155559999';
  try {
    const deliveries = await dispatchEscalationNotice({ reference: 'sess-1', reason: 'requested_human', clinicName: 'Riverside' });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].audience, 'clinic');
    assert.equal(deliveries[0].status, 'sent');
    assert.match(mockOutbox()[0].body, /requested_human/);
  } finally {
    delete process.env.CLINIC_NOTIFY_SMS;
  }
});
