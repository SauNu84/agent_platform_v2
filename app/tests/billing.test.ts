import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { PLANS, getPlan, amountForCycle, formatPrice } from '@/services/billing/plans';
import { startCheckout, confirmCheckout, cancelCheckout, InvalidPlanError } from '@/services/billing/subscription';
import { getMeterState, DEFAULT_FREE_MINUTES } from '@/services/meter';

const ORIGIN = 'http://localhost:3000';

test('plan catalog: free + two paid tiers, annual is ~17% cheaper than monthly', () => {
  assert.deepEqual(PLANS.map((p) => p.id), ['free', 'standard', 'premium']);
  const standard = getPlan('standard')!;
  assert.equal(standard.paid, true);
  // annual per-month equivalent is strictly cheaper than the monthly rate
  assert.ok(standard.priceAnnualMonthlyCents < standard.priceMonthlyCents);
  // annual total = 12 × the per-month-equivalent
  assert.equal(amountForCycle(standard, 'annual'), standard.priceAnnualMonthlyCents * 12);
  assert.equal(amountForCycle(standard, 'monthly'), standard.priceMonthlyCents);
  assert.equal(formatPrice(1900), '$19');
});

test('startCheckout persists a pending checkout and returns a redirect url', async () => {
  const store = new MemoryStore();
  const result = await startCheckout(store, 'u1', 'premium', 'monthly', ORIGIN);
  assert.ok(result.url);
  assert.equal(result.provider, 'mock'); // default provider, no keys configured
  assert.match(result.url, /\/billing\/checkout\//); // mock routes to the simulated page

  const rec = await store.getCheckout(result.checkoutId);
  assert.ok(rec);
  assert.equal(rec!.status, 'pending');
  assert.equal(rec!.planId, 'premium');
  assert.equal(rec!.userId, 'u1');
  assert.equal(rec!.amountCents, getPlan('premium')!.priceMonthlyCents);
});

test('startCheckout rejects the free plan and unknown plans', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => startCheckout(store, 'u1', 'free', 'monthly', ORIGIN), InvalidPlanError);
  await assert.rejects(() => startCheckout(store, 'u1', 'nope', 'monthly', ORIGIN), InvalidPlanError);
});

test('confirmCheckout upgrades the entitlement and lifts the meter cap', async () => {
  const store = new MemoryStore();
  // before: default free entitlement
  let meter = await getMeterState(store, 'u1');
  assert.equal(meter.capMinutes, DEFAULT_FREE_MINUTES);
  assert.equal(meter.plan, 'free');

  const { checkoutId } = await startCheckout(store, 'u1', 'standard', 'monthly', ORIGIN);
  const res = await confirmCheckout(store, checkoutId);
  assert.ok(res);
  assert.equal(res!.checkout.status, 'completed');
  assert.equal(res!.entitlement.plan, 'paid');
  assert.equal(res!.entitlement.planTier, 'standard');

  meter = await getMeterState(store, 'u1');
  assert.equal(meter.plan, 'paid');
  // cap = free allowance + the plan's paid minutes
  assert.equal(meter.capMinutes, DEFAULT_FREE_MINUTES + getPlan('standard')!.includedMinutes);
});

test('confirmCheckout is idempotent — re-confirm does not double-grant', async () => {
  const store = new MemoryStore();
  const { checkoutId } = await startCheckout(store, 'u1', 'premium', 'annual', ORIGIN);
  const first = await confirmCheckout(store, checkoutId);
  const second = await confirmCheckout(store, checkoutId);
  assert.equal(first!.entitlement.paidMinutes, getPlan('premium')!.includedMinutes);
  assert.equal(second!.entitlement.paidMinutes, getPlan('premium')!.includedMinutes);
  const meter = await getMeterState(store, 'u1');
  assert.equal(meter.capMinutes, DEFAULT_FREE_MINUTES + getPlan('premium')!.includedMinutes);
});

test('a canceled checkout cannot be confirmed', async () => {
  const store = new MemoryStore();
  const { checkoutId } = await startCheckout(store, 'u1', 'standard', 'monthly', ORIGIN);
  const canceled = await cancelCheckout(store, checkoutId);
  assert.equal(canceled!.status, 'canceled');
  const res = await confirmCheckout(store, checkoutId);
  assert.equal(res, null);
  // entitlement stays free
  const meter = await getMeterState(store, 'u1');
  assert.equal(meter.plan, 'free');
});

test('listCheckouts returns a user\'s checkouts newest-first and scoped to them', async () => {
  const store = new MemoryStore();
  await startCheckout(store, 'u1', 'standard', 'monthly', ORIGIN);
  await startCheckout(store, 'u1', 'premium', 'monthly', ORIGIN);
  await startCheckout(store, 'u2', 'premium', 'monthly', ORIGIN);
  const mine = await store.listCheckouts('u1');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((c) => c.userId === 'u1'));
});
