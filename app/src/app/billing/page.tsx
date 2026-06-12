/**
 * Usage & Billing (SAU-250) — the user's billing home.
 *
 * Server component: reads the live meter (Slice 2), the named subscription tier,
 * recent session usage (History projection), and past checkouts. The "Upgrade"
 * action + plan-selection modal are a client island (BillingClient) so the rest
 * renders server-side. No new metering or conversation engine — pure read-model.
 */
import { getStore } from '@/db';
import { getMeterState } from '@/services/meter';
import { listSessionHistory } from '@/services/history';
import { fmtDuration } from '@/services/history';
import { requirePageActor } from '@/services/current-user';
import { PLANS, getPlan, formatPrice } from '@/services/billing/plans';
import BillingClient from './BillingClient';

export const dynamic = 'force-dynamic';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const minutesOf = (ms: number) => (ms > 0 ? (ms / 60_000).toFixed(1) : '0.0');

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { upgraded?: string; canceled?: string };
}) {
  const store = getStore();
  const actor = await requirePageActor();
  const userId = actor.userId;

  const [meter, ent, history, checkouts] = await Promise.all([
    getMeterState(store, userId),
    store.getEntitlement(userId),
    listSessionHistory(store, userId),
    store.listCheckouts(userId),
  ]);

  const tier = ent?.planTier ?? 'free';
  const currentPlan = getPlan(tier) ?? PLANS[0];
  const upgradedPlan = searchParams.upgraded ? getPlan(searchParams.upgraded) : undefined;

  return (
    <div className="billing">
      <h1>Usage &amp; Billing</h1>
      <p className="subtitle">Monitor your usage and manage your subscription.</p>

      {upgradedPlan && (
        <div className="billing-banner success" role="status">
          🎉 You&apos;re now on the <strong>{upgradedPlan.name}</strong> plan. Your new minutes are ready to use.
        </div>
      )}
      {searchParams.canceled && (
        <div className="billing-banner" role="status">
          Checkout canceled — your plan is unchanged.
        </div>
      )}

      <div className="billing-cards">
        {/* ── Wallet balance ─────────────────────────────────────────────── */}
        <section className="card billing-card">
          <h3>Wallet balance</h3>
          <p className="billing-muted">Voice minutes available this cycle.</p>
          <div className="billing-balance">{meter.remainingMinutes.toFixed(1)}<span> min left</span></div>
          <p className="billing-muted">
            {meter.usedMinutes.toFixed(1)} of {meter.capMinutes.toFixed(0)} minutes used
          </p>
        </section>

        {/* ── Subscription plan ──────────────────────────────────────────── */}
        <section className="card billing-card">
          <h3>Subscription plan</h3>
          <p className="billing-muted">Your current plan and monthly allowance.</p>
          <div className="billing-plan-name">{currentPlan.name}</div>
          <div className="billing-plan-meta">
            <span>{currentPlan.includedMinutes} min / month</span>
            <span className="billing-price">
              {currentPlan.paid ? `${formatPrice(currentPlan.priceMonthlyCents)}/mo` : 'Free'}
            </span>
          </div>
          <BillingClient plans={PLANS} currentTier={tier} />
        </section>
      </div>

      {/* ── Usage statistics ──────────────────────────────────────────────── */}
      <section className="billing-section">
        <h2>Usage statistics</h2>
        <p className="billing-muted">An overview of your practice activity.</p>
        <div className="billing-stats">
          <div className="billing-stat">
            <div className="billing-stat-value">{history.length}</div>
            <div className="billing-stat-label">Total sessions</div>
          </div>
          <div className="billing-stat">
            <div className="billing-stat-value">{meter.usedMinutes.toFixed(1)}</div>
            <div className="billing-stat-label">Minutes used</div>
          </div>
          <div className="billing-stat">
            <div className="billing-stat-value">{meter.remainingMinutes.toFixed(1)}</div>
            <div className="billing-stat-label">Minutes remaining</div>
          </div>
        </div>
      </section>

      {/* ── Usage history ─────────────────────────────────────────────────── */}
      <section className="billing-section">
        <h2>Usage history</h2>
        <p className="billing-muted">Recent practice sessions and the minutes they used.</p>
        {history.length === 0 ? (
          <p className="billing-muted">No sessions yet — start practicing to see usage here.</p>
        ) : (
          <table className="billing-table">
            <thead>
              <tr><th>Date</th><th>Scenario</th><th>Duration</th><th className="num">Minutes</th></tr>
            </thead>
            <tbody>
              {history.slice(0, 10).map((r) => (
                <tr key={r.sessionId}>
                  <td>{fmtDate(r.startedAt)}</td>
                  <td>{r.scenarioName}</td>
                  <td>{r.durationMs > 0 ? fmtDuration(r.durationMs) : '—'}</td>
                  <td className="num">−{minutesOf(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Purchases ─────────────────────────────────────────────────────── */}
      <section className="billing-section">
        <h2>Purchases</h2>
        <p className="billing-muted">Your subscription checkouts.</p>
        {checkouts.length === 0 ? (
          <p className="billing-muted">No purchases yet.</p>
        ) : (
          <table className="billing-table">
            <thead>
              <tr><th>Date</th><th>Plan</th><th>Cycle</th><th>Status</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {checkouts.map((c) => (
                <tr key={c.id}>
                  <td>{fmtDate(c.createdAt)}</td>
                  <td>{getPlan(c.planId)?.name ?? c.planId}</td>
                  <td>{c.billingCycle}</td>
                  <td><span className={`billing-status ${c.status}`}>{c.status}</span></td>
                  <td className="num">{formatPrice(c.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
