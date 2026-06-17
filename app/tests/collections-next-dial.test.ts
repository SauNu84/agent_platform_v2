/**
 * SAU-335 (WS-4) — next-eligible-dial scheduler + per-tenant dashboard read-model.
 *
 * Proves the WS-4 acceptance criteria that are pure (no DB):
 *   • "Next eligible dial" is computed by WS-1's OWN gates (canDialNow), never a guess:
 *     the returned instant itself passes canDialNow, and a state-based suppression
 *     yields no date (permanentBlock) rather than a fabricated one.
 *   • The dashboard read-model aggregates outcomes, cadence, suppression and compliance
 *     blocks correctly, and the outcome → CallAttempt projection excludes blocked dials
 *     (no call was placed) so they never count toward the frequency caps.
 *
 * Tenant isolation under real RLS is proven separately in collections-dashboard-rls.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDialNow,
  nextEligibleDial,
  type CallAttempt,
  type DialEvaluableDebtor,
} from '@/domain/collections-engine';
import { MemoryStore } from '@/db/memory-store';
import { getCollectionsDashboard } from '@/services/collections-dashboard';

const DAY = 86_400_000;

// Deterministic instants in America/New_York (EDT = UTC-4 in June).
const WED_2PM_ET = Date.parse('2026-06-17T14:00:00-04:00'); // in-window working day
const SAT_2PM_ET = Date.parse('2026-06-20T14:00:00-04:00'); // weekend

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

// ── nextEligibleDial ────────────────────────────────────────────────────────

test('eligible now → nextMs is the current instant', () => {
  const r = nextEligibleDial(healthyDebtor(), WED_2PM_ET);
  assert.equal(r.allowedNow, true);
  assert.equal(r.nextMs, WED_2PM_ET);
  assert.equal(r.permanentBlock, false);
  assert.deepEqual(r.reasons, []);
});

test('opt-out / no-consent / dispute are PERMANENT blocks — no date is fabricated', () => {
  for (const over of [{ optedOut: true }, { consent: false }, { disputeOpen: true }]) {
    const r = nextEligibleDial(healthyDebtor(over), WED_2PM_ET);
    assert.equal(r.allowedNow, false);
    assert.equal(r.permanentBlock, true, `permanent for ${JSON.stringify(over)}`);
    assert.equal(r.nextMs, null, `no next date for ${JSON.stringify(over)}`);
  }
});

test('a time/frequency block returns a FUTURE instant that itself passes canDialNow', () => {
  // An attempt 2 days ago trips the 14-day default cadence → blocked now, eligible later.
  const attempts: CallAttempt[] = [{ atMs: WED_2PM_ET - 2 * DAY }];
  const r = nextEligibleDial(healthyDebtor(), WED_2PM_ET, { attempts });
  assert.equal(r.allowedNow, false);
  assert.equal(r.permanentBlock, false);
  assert.ok(r.nextMs && r.nextMs > WED_2PM_ET, 'a future date is returned');
  // The crux: the proposed instant is one the engine actually permits — not a guess.
  assert.equal(canDialNow(healthyDebtor(), r.nextMs!, { attempts }).decision, 'ALLOW');
  // …and it is at/after the cadence floor (≥12 days out from now).
  assert.ok(r.nextMs! - WED_2PM_ET >= 11 * DAY, 'respects the ~14-day cadence');
});

test('a weekend block resolves forward to a permitted weekday/in-window instant', () => {
  const r = nextEligibleDial(healthyDebtor(), SAT_2PM_ET);
  assert.equal(r.allowedNow, false);
  assert.equal(r.permanentBlock, false);
  assert.ok(r.nextMs, 'a next instant exists');
  assert.equal(canDialNow(healthyDebtor(), r.nextMs!).decision, 'ALLOW');
});

// ── getCollectionsDashboard (against the in-memory store) ─────────────────────

test('dashboard aggregates outcomes, cadence, suppression and compliance blocks per tenant', async () => {
  const store = new MemoryStore();
  const clinicId = 'lender-A';

  // Healthy, no attempts → eligible now.
  const ok = await store.upsertDebtor({
    clinicId, externalRef: 'D-OK', name: 'A', phone: '+12125550101', balanceCents: 1000,
    timezone: 'America/New_York', state: 'NY', consent: true,
  });
  // Opted out → suppressed, permanent block.
  const opt = await store.upsertDebtor({
    clinicId, externalRef: 'D-OPT', name: 'B', phone: '+12125550102', balanceCents: 2000,
    timezone: 'America/New_York', state: 'NY', consent: true, optedOut: true,
  });
  // No consent → blocked dial recorded.
  const noc = await store.upsertDebtor({
    clinicId, externalRef: 'D-NOC', name: 'C', phone: '+12125550103', balanceCents: 3000,
    timezone: 'America/New_York', state: 'NY', consent: false,
  });

  await store.recordCallAttempt({ clinicId, debtorId: ok.id, debtorRef: ok.externalRef, outcome: 'contacted', attemptedAtMs: WED_2PM_ET - 40 * DAY });
  await store.recordCallAttempt({ clinicId, debtorId: opt.id, debtorRef: opt.externalRef, outcome: 'opted_out', attemptedAtMs: WED_2PM_ET - 5 * DAY });
  await store.recordCallAttempt({ clinicId, debtorId: noc.id, debtorRef: noc.externalRef, outcome: 'blocked_by_compliance', blockReason: 'no_consent', blockReasons: ['no_consent'], attemptedAtMs: WED_2PM_ET - 1 * DAY });

  const m = await getCollectionsDashboard(store, clinicId, WED_2PM_ET);

  assert.equal(m.totalDebtors, 3);
  // 'contacted' (40d ago, > cadence) leaves D-OK eligible now; the other two are blocked.
  assert.equal(m.eligibleNow, 1);
  assert.equal(m.suppressed, 1); // only the opted-out debtor (no-consent isn't on the suppression list)
  assert.equal(m.outcomes.contacted, 1);
  assert.equal(m.outcomes.opted_out, 1);
  assert.equal(m.outcomes.blocked_by_compliance, 1);
  // Placed attempts exclude the compliance block (no call placed).
  assert.equal(m.totalAttempts, 2);
  assert.equal(m.blockedAttempts, 1);
  // The block is mirrored into the ledger as a dial_decision BLOCK → counted by reason.
  assert.deepEqual(m.complianceBlocks, [{ reason: 'no_consent', count: 1 }]);

  // The opted-out debtor's cadence row is a permanent block with no next date.
  const optRow = m.cadence.find((c) => c.externalRef === 'D-OPT')!;
  assert.equal(optRow.permanentBlock, true);
  assert.equal(optRow.nextEligibleAt, null);
  assert.ok(optRow.blockReasons.includes('opted_out'));

  // The healthy debtor is eligible now.
  const okRow = m.cadence.find((c) => c.externalRef === 'D-OK')!;
  assert.equal(okRow.allowedNow, true);
  assert.equal(okRow.attempts, 1);
  assert.equal(okRow.lastOutcome, 'contacted');
});
