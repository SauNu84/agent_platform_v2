import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NOTIFY_PROVIDER = 'mock';
process.env.HANDOFF_PROVIDER = 'mock';

import {
  classifyEscalation,
  callerRequestedHuman,
  isAfterHours,
  resolveHandoffAction,
} from '@/domain/escalation';
import { DEFAULT_CLINIC } from '@/domain/clinic';
import { handleEscalation, gracefulFallback } from '@/services/clinic-escalation';
import { __resetMockHandoff, mockHandoffLog } from '@/services/handoff';

const turn = (role: 'user' | 'agent', text: string) => ({ role, text, at: 0 });

// Known UTC times against DEFAULT_CLINIC hours (Wed 09:00–17:00, Sun closed).
const WED_OPEN = Date.parse('2026-06-17T14:00:00Z'); // Wednesday 14:00
const WED_CLOSED = Date.parse('2026-06-17T20:00:00Z'); // Wednesday 20:00
const SUNDAY = Date.parse('2026-06-14T14:00:00Z'); // Sunday (closed all day)

beforeEach(() => __resetMockHandoff());

// ── pure classification ──────────────────────────────────────────────────────
test('callerRequestedHuman detects an explicit ask for a person', () => {
  assert.equal(callerRequestedHuman([turn('user', 'Can I please talk to a human?')]), true);
  assert.equal(callerRequestedHuman([turn('user', 'I want to book for Tuesday')]), false);
  // an agent saying "human" must not trigger it — only user turns count.
  assert.equal(callerRequestedHuman([turn('agent', 'I am not a human, but I can help')]), false);
});

test('classifyEscalation: requested_human > forced > unresolved precedence', () => {
  assert.deepEqual(
    classifyEscalation({ turns: [turn('user', 'transfer me to the front desk')], outcome: 'booked' }),
    { escalate: true, reason: 'requested_human' },
  );
  assert.deepEqual(
    classifyEscalation({ turns: [], outcome: 'booked', forced: 'system_failure' }),
    { escalate: true, reason: 'system_failure' },
  );
  assert.deepEqual(
    classifyEscalation({ turns: [], outcome: 'escalated' }),
    { escalate: true, reason: 'unresolved' },
  );
  assert.deepEqual(classifyEscalation({ turns: [], outcome: 'booked' }), { escalate: false, reason: null });
});

test('isAfterHours respects the clinic hours table', () => {
  assert.equal(isAfterHours(DEFAULT_CLINIC.hours, WED_OPEN), false);
  assert.equal(isAfterHours(DEFAULT_CLINIC.hours, WED_CLOSED), true);
  assert.equal(isAfterHours(DEFAULT_CLINIC.hours, SUNDAY), true);
});

test('resolveHandoffAction: warm transfer in hours, voicemail/callback after hours', () => {
  assert.equal(resolveHandoffAction({ reason: 'requested_human', afterHours: false }), 'warm_transfer');
  assert.equal(resolveHandoffAction({ reason: 'requested_human', afterHours: true }), 'voicemail');
  assert.equal(resolveHandoffAction({ reason: 'system_failure', afterHours: true }), 'callback');
});

// ── orchestration ─────────────────────────────────────────────────────────────
test('open-hours human request → warm transfer with a Dial instruction', async () => {
  const out = await handleEscalation({
    turns: [turn('user', 'I need to talk to a human')],
    outcome: 'escalated',
    reference: 'sess-open',
    nowMs: WED_OPEN,
  });
  assert.equal(out.escalated, true);
  assert.equal(out.reason, 'requested_human');
  assert.equal(out.action, 'warm_transfer');
  assert.equal(out.afterHours, false);
  assert.match(out.handoff?.instruction ?? '', /Dial/);
  assert.equal(mockHandoffLog().length, 1);
});

test('after-hours unresolved call → voicemail (caller is not dropped)', async () => {
  const out = await handleEscalation({
    turns: [],
    outcome: 'escalated',
    reference: 'sess-night',
    nowMs: WED_CLOSED,
  });
  assert.equal(out.reason, 'unresolved');
  assert.equal(out.action, 'voicemail');
  assert.equal(out.afterHours, true);
  assert.match(out.handoff?.instruction ?? '', /Record/);
});

test('a non-escalating outcome does nothing', async () => {
  const out = await handleEscalation({ turns: [], outcome: 'booked', reference: 'sess-ok', nowMs: WED_OPEN });
  assert.equal(out.escalated, false);
  assert.equal(out.action, 'none');
  assert.equal(mockHandoffLog().length, 0);
});

test('gracefulFallback forces a system_failure escalation (mid-call hiccup never drops the caller)', async () => {
  const out = await gracefulFallback({ turns: [], reference: 'sess-crash', nowMs: WED_OPEN });
  assert.equal(out.escalated, true);
  assert.equal(out.reason, 'system_failure');
  // In open hours a failure still warm-transfers to a person.
  assert.equal(out.action, 'warm_transfer');

  const night = await gracefulFallback({ turns: [], reference: 'sess-crash2', nowMs: WED_CLOSED });
  assert.equal(night.action, 'callback');
});
