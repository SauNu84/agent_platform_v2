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
  topUpBlocks,
  GROSS_MARGIN_FLOOR,
  TOP_UP_BLOCK_MINUTES,
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

/**
 * Processor scenarios from the CFO's SAU-554 table (SAU-556: processor undecided).
 * VOICE_COGS_CENTS_PER_MINUTE excludes processing, and a fixed per-transaction fee
 * is regressive in bundle size — so the smallest purchasable top-up block must hold
 * the floor with processing included. (Plan subscriptions are NOT checked against
 * these: 87/211 land 64–67% with processing; the re-solve is pending on SAU-534.)
 */
const PROCESSORS = [
  { name: 'Stripe US', pct: 0.029, fixedCents: 30 },
  { name: 'Stripe intl', pct: 0.049, fixedCents: 30 },
  { name: 'Dodo MoR', pct: 0.055, fixedCents: 40 },
  { name: 'Paddle MoR', pct: 0.05, fixedCents: 50 },
] as const;

for (const proc of PROCESSORS) {
  test(`GM floor: minimum top-up block holds the floor incl. processing (${proc.name})`, () => {
    const price = topUpCents(getPlan('premium')!, 1)!;
    const fee = price * proc.pct + proc.fixedCents;
    const gm = (price - fee - TOP_UP_BLOCK_MINUTES * VOICE_COGS_CENTS_PER_MINUTE) / price;
    assert.ok(gm >= GROSS_MARGIN_FLOOR, `${proc.name}: ${(gm * 100).toFixed(2)}% on a ${price}¢ block`);
  });
}

test('SAU-554 ratified allowances: 87 / 211 included, caps 117 / 241', () => {
  assert.equal(getPlan('standard')!.includedMinutes, 87);
  assert.equal(getPlan('premium')!.includedMinutes, 211);
  assert.equal(getPlan('standard')!.features[0], '87 practice minutes / month');
  assert.equal(getPlan('premium')!.features[0], '211 practice minutes / month');
  assert.equal(FREE_MINUTES + getPlan('standard')!.includedMinutes, 117);
  assert.equal(FREE_MINUTES + getPlan('premium')!.includedMinutes, 241);
});

test('top-up: only plans that advertise it carry the rate; charge rounds up to whole blocks', () => {
  const premium = getPlan('premium')!;
  assert.equal(TOP_UP_CENTS_PER_MINUTE, 25);
  assert.equal(premium.topUpCentsPerMinute, TOP_UP_CENTS_PER_MINUTE);
  assert.ok(premium.features.some((f) => /top up/i.test(f)));
  for (const p of PLANS.filter((x) => x.topUpCentsPerMinute == null)) {
    assert.ok(!p.features.some((f) => /top up/i.test(f)), `${p.id} advertises top-up without a rate`);
    assert.equal(topUpCents(p, 10), null);
  }
  assert.equal(TOP_UP_BLOCK_MINUTES, 30);
  assert.equal(topUpCents(premium, 1), 750);
  assert.equal(topUpCents(premium, 30), 750);
  assert.equal(topUpCents(premium, 30.2), 1500);
  assert.equal(topUpBlocks(61), 3);
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
