'use client';

/**
 * Pay / Cancel controls for the simulated hosted-checkout page (SAU-250).
 * "Pay" confirms the checkout (upgrading the entitlement) and returns to Billing.
 */
import { useState } from 'react';

export default function CheckoutClient({ checkoutId, planId }: { checkoutId: string; planId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/checkout/${checkoutId}/confirm`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Payment could not be confirmed.');
      window.location.href = `/billing?upgraded=${planId}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="checkout-actions">
      {error && <p className="billing-error" role="alert">{error}</p>}
      <button type="button" className="btn join" onClick={pay} disabled={busy}>
        {busy ? 'Processing…' : 'Pay now'}
      </button>
      <a className="btn-sm" href="/billing?canceled=1">Cancel</a>
    </div>
  );
}
