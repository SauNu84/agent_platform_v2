'use client';

/**
 * Billing client island (SAU-250) — the "Upgrade" button and the "Choose a
 * Subscription Plan" modal. Selecting a paid plan and hitting "Continue to
 * Checkout" starts a checkout (POST /api/billing/checkout) and redirects the
 * browser to the payment provider's hosted page.
 */
import { useState } from 'react';
import { type Plan, type PlanId, type BillingCycle, ANNUAL_DISCOUNT, formatPrice } from '@/services/billing/plans';

export default function BillingClient({
  plans,
  currentTier,
  trigger = null,
}: {
  plans: Plan[];
  currentTier: PlanId;
  /** raw `?trigger=` from the paywall link that sent the user here (SAU-557) */
  trigger?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  // Default the selection to the first paid plan above the current one.
  const defaultSel = plans.find((p) => p.paid && p.id !== currentTier)?.id ?? currentTier;
  const [selected, setSelected] = useState<PlanId>(defaultSel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPlan = plans.find((p) => p.id === selected)!;
  const isCurrent = selected === currentTier;
  const canCheckout = selectedPlan.paid && !isCurrent;

  const priceCents = (p: Plan) => (cycle === 'annual' ? p.priceAnnualMonthlyCents : p.priceMonthlyCents);

  async function checkout() {
    if (!canCheckout) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: selected, cycle, trigger }), // SAU-557 upgrade.started{trigger}
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Checkout could not be started.');
      window.location.href = json.url; // hand off to the payment provider
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const ctaLabel = isCurrent ? 'Current plan' : canCheckout ? 'Continue to Checkout' : 'Select a plan';

  return (
    <>
      <button type="button" className="btn billing-upgrade" onClick={() => setOpen(true)}>
        {currentTier === 'free' ? 'Upgrade to Premium' : 'Change plan'}
      </button>

      {open && (
        <div
          className="kb-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a subscription plan"
          onClick={() => !busy && setOpen(false)}
        >
          <div className="kb-modal billing-modal" onClick={(e) => e.stopPropagation()}>
            <div className="kb-modal-head">
              <h2>Choose a Subscription Plan</h2>
              <button className="btn-remove" aria-label="Close" onClick={() => !busy && setOpen(false)}>
                ×
              </button>
            </div>

            {/* Billing-cycle toggle */}
            <div className="billing-cycle" role="tablist" aria-label="Billing cycle">
              <button
                type="button"
                role="tab"
                aria-selected={cycle === 'monthly'}
                className={cycle === 'monthly' ? 'on' : ''}
                onClick={() => setCycle('monthly')}
              >
                Monthly
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={cycle === 'annual'}
                className={cycle === 'annual' ? 'on' : ''}
                onClick={() => setCycle('annual')}
              >
                Annual <span className="billing-save">save {Math.round(ANNUAL_DISCOUNT * 100)}%</span>
              </button>
            </div>

            {/* Plan cards */}
            <div className="billing-plan-grid">
              {plans.map((p) => {
                const sel = p.id === selected;
                const current = p.id === currentTier;
                return (
                  <button
                    type="button"
                    key={p.id}
                    className={`billing-plan-card${sel ? ' selected' : ''}`}
                    aria-pressed={sel}
                    onClick={() => setSelected(p.id)}
                  >
                    <div className="billing-plan-head">
                      <span className="billing-plan-title">{p.name}</span>
                      {current && <span className="billing-current-badge">Current plan</span>}
                    </div>
                    <p className="billing-plan-tagline">{p.tagline}</p>
                    <div className="billing-plan-price">
                      {p.paid ? (
                        <>
                          {formatPrice(priceCents(p))}
                          <span> /mo{cycle === 'annual' ? ' billed yearly' : ''}</span>
                        </>
                      ) : (
                        'Free'
                      )}
                    </div>
                    <div className="billing-plan-includes">Includes:</div>
                    <ul className="billing-plan-features">
                      {p.features.map((f) => (
                        <li key={f}>
                          <span aria-hidden="true">✓</span> {f}
                        </li>
                      ))}
                    </ul>
                  </button>
                );
              })}
            </div>

            {error && <p className="billing-error" role="alert">{error}</p>}

            <div className="billing-modal-foot">
              <button
                type="button"
                className="btn billing-checkout-btn"
                disabled={!canCheckout || busy}
                onClick={checkout}
              >
                {busy ? 'Starting checkout…' : ctaLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
