/**
 * Billing orchestration (SAU-250) — start a checkout, then confirm it.
 *
 * Flow:
 *   1. startCheckout: validate the chosen paid plan, persist a PENDING checkout
 *      row, mint a provider session, return the URL to redirect the user to.
 *   2. confirmCheckout: on the provider's success return/webhook, mark the
 *      checkout COMPLETED and upgrade the user's entitlement (idempotent — a
 *      re-confirm is a no-op). The LLM/provider never writes the entitlement
 *      directly; only this gated path does.
 *
 * The entitlement upgrade sets plan='paid' (so the meter cap lifts), records the
 * named tier, and grants the plan's voice-minute allowance as paid minutes.
 */
import type { Store, CheckoutRecord, EntitlementRecord } from '@/db/store';
import { getPlan, amountForCycle, type BillingCycle, type Plan } from './plans';
import { getCheckoutProvider } from './checkout-provider';

export class InvalidPlanError extends Error {
  constructor(planId: string) {
    super(`unknown or non-purchasable plan: ${planId}`);
    this.name = 'InvalidPlanError';
  }
}

export interface StartCheckoutResult {
  checkoutId: string;
  url: string;
  provider: string;
  plan: Plan;
}

/** Validate + persist a pending checkout and return the provider redirect URL. */
export async function startCheckout(
  store: Store,
  userId: string,
  planId: string,
  cycle: BillingCycle,
  origin: string,
): Promise<StartCheckoutResult> {
  const plan = getPlan(planId);
  if (!plan || !plan.paid) throw new InvalidPlanError(planId);

  const amountCents = amountForCycle(plan, cycle);
  const provider = getCheckoutProvider();
  const checkoutId = crypto.randomUUID();

  const rec: CheckoutRecord = {
    id: checkoutId,
    userId,
    planId: plan.id,
    billingCycle: cycle,
    provider: provider.name,
    amountCents,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await store.createCheckout(rec);

  const session = await provider.createSession({
    checkoutId,
    plan,
    cycle,
    amountCents,
    userId,
    successUrl: `${origin}/billing?upgraded=${plan.id}`,
    cancelUrl: `${origin}/billing?canceled=1`,
  });

  return { checkoutId, url: session.url, provider: session.provider, plan };
}

/**
 * Confirm a completed payment and upgrade the entitlement. Idempotent: confirming
 * an already-completed checkout returns the same result without double-granting.
 * Returns null if the checkout id is unknown.
 */
export async function confirmCheckout(
  store: Store,
  checkoutId: string,
): Promise<{ checkout: CheckoutRecord; entitlement: EntitlementRecord } | null> {
  const checkout = await store.getCheckout(checkoutId);
  if (!checkout) return null;
  if (checkout.status === 'canceled') return null;

  const plan = getPlan(checkout.planId);
  if (!plan || !plan.paid) throw new InvalidPlanError(checkout.planId);

  const completed =
    checkout.status === 'completed'
      ? checkout
      : (await store.setCheckoutStatus(checkoutId, 'completed')) ?? checkout;

  const current = await store.getEntitlement(checkout.userId);
  const entitlement: EntitlementRecord = {
    userId: checkout.userId,
    plan: 'paid',
    freeMinutes: current?.freeMinutes ?? 30,
    paidMinutes: plan.includedMinutes,
    planTier: plan.id as EntitlementRecord['planTier'],
  };
  await store.upsertEntitlement(entitlement);

  return { checkout: completed, entitlement };
}

/** Mark a checkout canceled (user backed out of the provider page). */
export async function cancelCheckout(store: Store, checkoutId: string): Promise<CheckoutRecord | null> {
  const checkout = await store.getCheckout(checkoutId);
  if (!checkout || checkout.status === 'completed') return checkout;
  return store.setCheckoutStatus(checkoutId, 'canceled');
}
