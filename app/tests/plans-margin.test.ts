/**
 * SAU-554 — gross-margin guardrail for the plan catalog.
 *
 * The SAU-198 70% GM floor used to be guarded only by a comment in plans.ts, and
 * the comment was wrong ($19/120min never held it). This test makes the floor a
 * build failure: edit a price, an allowance, or the measured COGS and every paid
 * plan is re-checked at the ANNUAL rate (the binding case — ~17% cheaper).
 *
 * Worst case assumed: a subscriber burns the full cap (free + included minutes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import {
  PLANS,
  getPlan,
  amountForCycle,
  topUpCents,
  GROSS_MARGIN_FLOOR,
  TOP_UP_CENTS_PER_MINUTE,
  VOICE_COGS_CENTS_PER_MINUTE,
} from '@/services/billing/plans';
import { startCheckout, confirmCheckout } from '@/services/billing/subscription';
import { getMeterState, DEFAULT_FREE_MINUTES } from '@/services/meter';

const FREE_MINUTES = getPlan('free')!.includedMinutes;

function grossMargin(revenueCents: number, minutes: number): number {
  return (revenueCents - minutes * VOICE_COGS_CENTS_PER_MINUTE) / revenueCents;
}

for (const plan of PLANS.filter((p) => p.paid)) {
  for (const cycle of ['monthly', 'annual'] as const) {
    test(`GM floor: ${plan.id} @ ${cycle} holds >= ${GROSS_MARGIN_FLOOR * 100}% at full cap`, () => {
      const monthlyRevenue = amountForCycle(plan, cycle) / (cycle === 'annual' ? 12 : 1);
      const capMinutes = FREE_MINUTES + plan.includedMinutes;
      const gm = grossMargin(monthlyRevenue, capMinutes);
      assert.ok(
        gm >= GROSS_MARGIN_FLOOR,
        `${plan.id} ${cycle}: GM ${(gm * 100).toFixed(2)}% < floor ` +
          `(${capMinutes} min × ${VOICE_COGS_CENTS_PER_MINUTE}¢ vs ${monthlyRevenue}¢/mo)`,
      );
    });
  }
}

test('GM floor: top-up rate holds the floor per extra minute', () => {
  assert.ok(grossMargin(TOP_UP_CENTS_PER_MINUTE, 1) >= GROSS_MARGIN_FLOOR);
});

test('SAU-554 ratified allowances: 87 / 211 included, caps 117 / 241', () => {
  assert.equal(getPlan('standard')!.includedMinutes, 87);
  assert.equal(getPlan('premium')!.includedMinutes, 211);
  assert.equal(getPlan('standard')!.features[0], '87 practice minutes / month');
  assert.equal(getPlan('premium')!.features[0], '211 practice minutes / month');
  assert.equal(FREE_MINUTES + getPlan('standard')!.includedMinutes, 117);
  assert.equal(FREE_MINUTES + getPlan('premium')!.includedMinutes, 241);
});

test('top-up: only plans that advertise it carry the rate; charge rounds up to whole minutes', () => {
  const premium = getPlan('premium')!;
  assert.equal(TOP_UP_CENTS_PER_MINUTE, 25);
  assert.equal(premium.topUpCentsPerMinute, TOP_UP_CENTS_PER_MINUTE);
  assert.ok(premium.features.some((f) => /top up/i.test(f)));
  for (const p of PLANS.filter((x) => x.topUpCentsPerMinute == null)) {
    assert.ok(!p.features.some((f) => /top up/i.test(f)), `${p.id} advertises top-up without a rate`);
    assert.equal(topUpCents(p, 10), null);
  }
  assert.equal(topUpCents(premium, 10), 250);
  assert.equal(topUpCents(premium, 9.2), 250);
  assert.equal(topUpCents(premium, -3), 0);
});

test('meter: a premium subscriber sees the top-up rate; free does not', async () => {
  const store = new MemoryStore();
  assert.equal((await getMeterState(store, 'u-free')).topUpCentsPerMinute, null);

  const { checkoutId } = await startCheckout(store, 'u-prem', 'premium', 'monthly', 'http://localhost:3000');
  await confirmCheckout(store, checkoutId);
  const meter = await getMeterState(store, 'u-prem');
  assert.equal(meter.topUpCentsPerMinute, TOP_UP_CENTS_PER_MINUTE);
  assert.equal(meter.capMinutes, DEFAULT_FREE_MINUTES + 211);
});
