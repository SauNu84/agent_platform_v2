/**
 * Simulated hosted-checkout page (SAU-250).
 *
 * Under the default mock provider, /api/billing/checkout redirects here instead of
 * to Stripe / DodoPayments. It stands in for the provider's hosted payment page so
 * the whole subscribe → pay → upgrade flow is exercisable without a payment account.
 * In production (BILLING_PROVIDER=stripe|dodo + key set) the redirect goes to the
 * real provider and this page is never reached.
 */
import { redirect, notFound } from 'next/navigation';
import { getStore } from '@/db';
import { requirePageActor } from '@/services/current-user';
import { getPlan, formatPrice, type BillingCycle } from '@/services/billing/plans';
import CheckoutClient from './CheckoutClient';

export const dynamic = 'force-dynamic';

export default async function CheckoutPage({ params }: { params: { id: string } }) {
  const store = getStore();
  const actor = await requirePageActor();
  const checkout = await store.getCheckout(params.id);

  if (!checkout || checkout.userId !== actor.userId) notFound();
  if (checkout.status === 'completed') redirect(`/billing?upgraded=${checkout.planId}`);
  if (checkout.status === 'canceled') redirect('/billing?canceled=1');

  const plan = getPlan(checkout.planId);
  if (!plan) notFound();
  const cycle = checkout.billingCycle as BillingCycle;

  return (
    <div className="checkout-page">
      <div className="card checkout-box">
        <div className="checkout-provider-tag">Simulated {checkout.provider} checkout</div>
        <h1>Confirm your subscription</h1>
        <p className="billing-muted">
          This stands in for the payment provider&apos;s hosted page. No card is charged.
        </p>

        <div className="checkout-summary">
          <div className="checkout-row">
            <span>Plan</span>
            <strong>{plan.name}</strong>
          </div>
          <div className="checkout-row">
            <span>Billing</span>
            <strong>{cycle === 'annual' ? 'Annual (billed yearly)' : 'Monthly'}</strong>
          </div>
          <div className="checkout-row">
            <span>Includes</span>
            <strong>{plan.includedMinutes} minutes / month</strong>
          </div>
          <div className="checkout-row total">
            <span>Total due</span>
            <strong>{formatPrice(checkout.amountCents)}</strong>
          </div>
        </div>

        <CheckoutClient checkoutId={checkout.id} planId={checkout.planId} />
      </div>
    </div>
  );
}
