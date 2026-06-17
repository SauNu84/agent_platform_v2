/**
 * SAU-332 — Collections compliance engine + cadence scheduler (WS-1).
 *
 * "The rules ARE the product." These tests prove each board-accepted guardrail
 * (SAU-330 §6) is enforced server-side as a hard gate, with an allow path and a block
 * path for every one, fail-closed behavior on unknown input, and — critically — that
 * the Reg-F 7-in-7 ceiling cannot be loosened by any per-tenant config.
 *
 * Coordination with WS-2 (SAU-333): the engine consumes WS-2's `Debtor` shape; one
 * test pins that a full `Debtor` is assignable to the engine input (real composition).
 *
 * Synthetic debtors only; the engine is pure decision logic and never dials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Debtor } from '@/domain/collections';
import {
  canDialNow,
  isDialAllowed,
  resolveTimeZone,
  areaCodeOf,
  getLocalParts,
  isHoliday,
  REG_F_MAX_ATTEMPTS,
  type CallAttempt,
  type DialBlockCode,
  type DialEvaluableDebtor,
  type DialEvaluation,
  type TenantCollectionsConfig,
} from '@/domain/collections-engine';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// Deterministic instants in America/New_York (EDT = UTC-4 in June).
// 2026-06-17 is a Wednesday (working day, not a holiday).
const WED_2PM_ET = Date.parse('2026-06-17T14:00:00-04:00'); // in-window working day
const WED_8PM_ET = Date.parse('2026-06-17T20:00:00-04:00'); // out of window
const SAT_2PM_ET = Date.parse('2026-06-20T14:00:00-04:00'); // weekend
const JUNETEENTH_2PM_ET = Date.parse('2026-06-19T14:00:00-04:00'); // Fri holiday

/** A debtor that passes every gate at WED_2PM_ET unless a test overrides a field. */
function healthyDebtor(over: Partial<DialEvaluableDebtor> = {}): DialEvaluableDebtor {
  return {
    timezone: 'America/New_York',
    phone: '+1-212-555-0100',
    state: 'NY',
    consent: true,
    optedOut: false,
    disputeOpen: false,
    ...over,
  };
}

const attemptsOpt = (attempts: CallAttempt[], config?: TenantCollectionsConfig) => ({ attempts, config });
const codes = (d: DialEvaluation): DialBlockCode[] => d.reasons.map((r) => r.code);

// ──────────────────────────────────────────────────────────────────────────
// Composition with WS-2 (SAU-333): a real Debtor is a valid engine input
// ──────────────────────────────────────────────────────────────────────────

test('a full WS-2 Debtor is assignable to the engine and evaluates', () => {
  const debtor: Debtor = {
    id: 'uuid-1',
    clinicId: 'lender-1',
    externalRef: 'acct-001',
    name: 'Synthetic Person',
    phone: '+12125550100',
    balanceCents: 125_00,
    timezone: 'America/New_York',
    state: 'NY',
    consent: true,
    optedOut: false,
    optedOutAt: null,
    disputeOpen: false,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
  // The Debtor flows straight into canDialNow with no adaptation (the WS-1↔WS-2 contract).
  assert.equal(canDialNow(debtor, WED_2PM_ET).decision, 'ALLOW');
});

// ──────────────────────────────────────────────────────────────────────────
// Allow path (all gates pass)
// ──────────────────────────────────────────────────────────────────────────

test('ALLOW: healthy debtor, in-window working day, consent on file, no history', () => {
  const d = canDialNow(healthyDebtor(), WED_2PM_ET);
  assert.equal(d.decision, 'ALLOW');
  assert.equal(d.reasons.length, 0);
  assert.equal(isDialAllowed(healthyDebtor(), WED_2PM_ET), true);
});

test('ALLOW: old history (attempts + conversation > windows ago) does not block', () => {
  const d = canDialNow(healthyDebtor(), WED_2PM_ET, attemptsOpt([{ atMs: WED_2PM_ET - 30 * DAY, hadConversation: true }]));
  assert.equal(d.decision, 'ALLOW');
});

// ──────────────────────────────────────────────────────────────────────────
// §6 #1 Calling-window gate — working days + 9–5 debtor-local
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: outside 9–5 debtor-local window', () => {
  const d = canDialNow(healthyDebtor(), WED_8PM_ET);
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('outside_calling_window'));
});

test('BLOCK: weekend is a non-working day', () => {
  const d = canDialNow(healthyDebtor(), SAT_2PM_ET);
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('non_working_day'));
});

test('window is evaluated in debtor-local time, not server time', () => {
  // 14:00 in Los Angeles is in-window; the SAME instant is 17:00 ET (out of window).
  const pacific = healthyDebtor({ timezone: 'America/Los_Angeles', phone: '+1-415-555-0100', state: 'CA' });
  const laAfternoon = Date.parse('2026-06-17T14:00:00-07:00'); // 14:00 PT == 17:00 ET
  assert.equal(canDialNow(pacific, laAfternoon).decision, 'ALLOW');
  assert.ok(codes(canDialNow(healthyDebtor(), laAfternoon)).includes('outside_calling_window'));
});

// ──────────────────────────────────────────────────────────────────────────
// §6 #7 Holiday calendar
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: observed federal holiday (Juneteenth)', () => {
  const d = canDialNow(healthyDebtor(), JUNETEENTH_2PM_ET);
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('holiday'));
});

test('BLOCK: tenant-configured extra holiday', () => {
  const d = canDialNow(healthyDebtor(), WED_2PM_ET, { config: { holidays: ['2026-06-17'] } });
  assert.ok(codes(d).includes('holiday'));
});

// ──────────────────────────────────────────────────────────────────────────
// §6 #3 Do-not-call / opt-out suppression
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: opt-out / do-not-call suppresses the debtor', () => {
  const d = canDialNow(healthyDebtor({ optedOut: true }), WED_2PM_ET);
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('opted_out'));
});

// ──────────────────────────────────────────────────────────────────────────
// §6 #4 Consent gate before dial
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: no consent on file', () => {
  const d = canDialNow(healthyDebtor({ consent: false }), WED_2PM_ET);
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('no_consent'));
});

// ──────────────────────────────────────────────────────────────────────────
// §6 #9 Validation-notice / dispute tracking
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: open validation dispute pauses calling', () => {
  const d = canDialNow(healthyDebtor({ disputeOpen: true }), WED_2PM_ET);
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('dispute_open'));
});

// ──────────────────────────────────────────────────────────────────────────
// §6 #6 Per-debtor time-zone resolution — fail closed on unknown TZ
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: unknown time zone fails closed (no resolvable TZ, unmapped area code)', () => {
  const d = canDialNow(healthyDebtor({ timezone: '', phone: '+1-999-555-0100' }), WED_2PM_ET);
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('unknown_timezone'));
});

test('BLOCK: invalid IANA tz string fails closed', () => {
  const d = canDialNow(healthyDebtor({ timezone: 'Mars/Olympus', phone: undefined }), WED_2PM_ET);
  assert.ok(codes(d).includes('unknown_timezone'));
});

test('area-code fallback resolves TZ when no explicit zone is set', () => {
  // 617 (Boston) → America/New_York; in-window instant ⇒ ALLOW.
  const d = canDialNow(healthyDebtor({ timezone: '', phone: '+1 (617) 555-0142' }), WED_2PM_ET);
  assert.equal(d.decision, 'ALLOW');
});

// ──────────────────────────────────────────────────────────────────────────
// §6 #2 Frequency cap — cadence, Reg-F 7-in-7, state cap, conversation cooldown
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: within default 2-week cadence since last attempt', () => {
  const d = canDialNow(healthyDebtor(), WED_2PM_ET, attemptsOpt([{ atMs: WED_2PM_ET - 3 * DAY }]));
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('cadence_not_elapsed'));
});

test('ALLOW: cadence elapsed (last attempt 15 days ago, default 14-day cadence)', () => {
  const d = canDialNow(healthyDebtor(), WED_2PM_ET, attemptsOpt([{ atMs: WED_2PM_ET - 15 * DAY }]));
  assert.equal(d.decision, 'ALLOW');
});

test('BLOCK: Reg-F 7-in-7 ceiling reached', () => {
  // 7 attempts in the last 7 hours. Disable cadence so we isolate the Reg-F gate.
  const attempts = Array.from({ length: REG_F_MAX_ATTEMPTS }, (_, i) => ({ atMs: WED_2PM_ET - (i + 1) * HOUR }));
  const d = canDialNow(healthyDebtor(), WED_2PM_ET, attemptsOpt(attempts, { cadenceDays: 0 }));
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('reg_f_7_in_7'));
});

test('Reg-F 7-in-7 ceiling CANNOT be overridden by aggressive per-tenant config', () => {
  // The loosest a tenant can configure: 1-day cadence. The hard ceiling must still bite.
  const attempts = Array.from({ length: REG_F_MAX_ATTEMPTS }, (_, i) => ({ atMs: WED_2PM_ET - (i + 1) * HOUR }));
  const d = canDialNow(healthyDebtor(), WED_2PM_ET, attemptsOpt(attempts, { cadenceDays: 1 }));
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('reg_f_7_in_7'), 'Reg-F ceiling is a hard, un-overridable gate');
});

test('ALLOW: 6 attempts in 7 days is under the Reg-F ceiling (cadence disabled)', () => {
  const attempts = Array.from({ length: REG_F_MAX_ATTEMPTS - 1 }, (_, i) => ({ atMs: WED_2PM_ET - (i + 1) * HOUR }));
  const d = canDialNow(healthyDebtor(), WED_2PM_ET, attemptsOpt(attempts, { cadenceDays: 0 }));
  assert.equal(d.decision, 'ALLOW');
});

test('BLOCK: per-state stricter cap (MA 2-in-7) bites before Reg-F', () => {
  const attempts = [{ atMs: WED_2PM_ET - 1 * DAY }, { atMs: WED_2PM_ET - 2 * DAY }];
  const config: TenantCollectionsConfig = { cadenceDays: 0, stateCaps: { MA: { maxAttempts: 2, windowDays: 7 } } };
  const d = canDialNow(healthyDebtor({ state: 'MA' }), WED_2PM_ET, attemptsOpt(attempts, config));
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('state_cap'));
  assert.ok(!codes(d).includes('reg_f_7_in_7'), 'only 2 attempts — under Reg-F, but over the MA cap');
});

test('BLOCK: Reg-F 7-day post-conversation cooldown', () => {
  const d = canDialNow(
    healthyDebtor(),
    WED_2PM_ET,
    attemptsOpt([{ atMs: WED_2PM_ET - 3 * DAY, hadConversation: true }], { cadenceDays: 0 }),
  );
  assert.equal(d.decision, 'BLOCK');
  assert.ok(codes(d).includes('conversation_cooldown'));
});

// ──────────────────────────────────────────────────────────────────────────
// Fail-closed input validation + multi-reason reporting
// ──────────────────────────────────────────────────────────────────────────

test('BLOCK: missing debtor fails closed', () => {
  assert.ok(codes(canDialNow(null, WED_2PM_ET)).includes('unknown_input'));
  assert.ok(codes(canDialNow(undefined, WED_2PM_ET)).includes('unknown_input'));
});

test('BLOCK: non-finite now fails closed', () => {
  assert.ok(codes(canDialNow(healthyDebtor(), Number.NaN)).includes('unknown_input'));
});

test('all failing gates are reported together, not just the first', () => {
  const d = canDialNow(healthyDebtor({ consent: false, optedOut: true, disputeOpen: true }), WED_8PM_ET);
  assert.equal(d.decision, 'BLOCK');
  for (const c of ['opted_out', 'no_consent', 'dispute_open', 'outside_calling_window'] as DialBlockCode[]) {
    assert.ok(codes(d).includes(c), `expected reason ${c}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Helper unit coverage
// ──────────────────────────────────────────────────────────────────────────

test('areaCodeOf / resolveTimeZone', () => {
  assert.equal(areaCodeOf('+1-312-555-0100'), '312');
  assert.equal(areaCodeOf('(415) 555-0100'), '415');
  assert.equal(areaCodeOf('garbage'), null);
  assert.equal(resolveTimeZone({ timezone: 'America/Denver', phone: undefined }), 'America/Denver');
  assert.equal(resolveTimeZone({ timezone: '', phone: '+1-312-555-0100' }), 'America/Chicago');
  assert.equal(resolveTimeZone({ timezone: '', phone: '+1-999-555-0100' }), null);
});

test('getLocalParts decomposes an instant into debtor-local wall-clock', () => {
  const p = getLocalParts(WED_2PM_ET, 'America/New_York');
  assert.ok(p);
  assert.equal(p!.weekday, 3); // Wednesday
  assert.equal(p!.hour, 14);
  assert.equal(p!.dateStr, '2026-06-17');
  assert.equal(getLocalParts(Number.NaN, 'America/New_York'), null);
  assert.equal(getLocalParts(WED_2PM_ET, 'Bad/Zone'), null);
});

test('isHoliday matches built-in and configured dates', () => {
  assert.equal(isHoliday('2026-12-25'), true); // Christmas
  assert.equal(isHoliday('2026-06-17'), false);
  assert.equal(isHoliday('2026-06-17', ['2026-06-17']), true);
});
