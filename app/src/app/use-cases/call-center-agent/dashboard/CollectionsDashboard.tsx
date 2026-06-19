'use client';

/**
 * CollectionsDashboard (SAU-335, WS-4) — client island for the per-lender collections
 * ops dashboard. Renders a lender switcher (switch active / create a lender) plus, for
 * the active lender: cadence + next-eligible-dial per debtor, the suppression / opt-out
 * list, compliance-block counts, and a read-only guardrail-10 audit trail. Switching or
 * creating a lender re-fetches GET /api/use-cases/call-center-agent/dashboard so the
 * view always reflects the active tenant (RLS-scoped server-side). Synthetic data only.
 */
import { useState, useEffect } from 'react';

interface LenderSummary {
  id: string;
  slug: string;
  name: string;
  configured: boolean;
  active: boolean;
}

interface SwitcherView {
  clinics: LenderSummary[];
  activeClinicId: string | null;
}

type Outcome =
  | 'contacted'
  | 'promised_to_pay'
  | 'no_answer'
  | 'voicemail_left'
  | 'opted_out'
  | 'dispute_raised'
  | 'blocked_by_compliance';

interface CadenceRow {
  debtorId: string;
  externalRef: string;
  state: string | null;
  consent: boolean;
  optedOut: boolean;
  disputeOpen: boolean;
  attempts: number;
  lastAttemptAt: string | null;
  lastOutcome: Outcome | null;
  allowedNow: boolean;
  nextEligibleAt: string | null;
  permanentBlock: boolean;
  blockReasons: string[];
}

interface AuditRow {
  ts: string;
  eventType: string;
  decision: string | null;
  reason: string | null;
  debtorRef: string;
  actorLabel: string;
}

interface Metrics {
  clinicId: string;
  totalDebtors: number;
  eligibleNow: number;
  suppressed: number;
  totalAttempts: number;
  outcomes: Record<Outcome, number>;
  contactRate: number;
  promisedToPay: number;
  blockedAttempts: number;
  complianceBlocks: { reason: string; count: number }[];
  cadence: CadenceRow[];
  suppressionList: CadenceRow[];
  recentAudit: AuditRow[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

const OUTCOME_LABEL: Record<Outcome, string> = {
  contacted: '✅ Contacted',
  promised_to_pay: '🤝 Promise to pay',
  no_answer: '📵 No answer',
  voicemail_left: '📨 Voicemail',
  opted_out: '🚫 Opted out',
  dispute_raised: '⚖️ Dispute raised',
  blocked_by_compliance: '⛔ Blocked (compliance)',
};

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="settings-integration" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
      <span className="billing-muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      <strong style={{ fontSize: 26, lineHeight: 1.1 }}>{value}</strong>
      {hint && <span className="billing-muted" style={{ fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

/** Render the cadence status cell: eligible-now / next-eligible time / suppressed (+why). */
function StatusCell({ row }: { row: CadenceRow }) {
  if (row.allowedNow) return <span style={{ color: 'var(--success, #16a34a)' }}>● Eligible now</span>;
  if (row.permanentBlock) {
    return (
      <span title={row.blockReasons.join(', ')} style={{ color: 'var(--danger, #dc2626)' }}>
        ⛔ Suppressed{row.blockReasons.length ? ` (${row.blockReasons[0]})` : ''}
      </span>
    );
  }
  if (row.nextEligibleAt) {
    return (
      <span title={row.blockReasons.join(', ')} className="billing-muted">
        ⏳ Next: {fmt(row.nextEligibleAt)}
      </span>
    );
  }
  return <span className="billing-muted" title={row.blockReasons.join(', ')}>— none in 30d</span>;
}

export default function CollectionsDashboard({
  initialSwitcher,
  initialMetrics,
}: {
  initialSwitcher: SwitcherView;
  initialMetrics: Metrics | null;
}) {
  const [switcher, setSwitcher] = useState<SwitcherView>(initialSwitcher);
  const [metrics, setMetrics] = useState<Metrics | null>(initialMetrics);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  // Always (re)fetch on mount: server-rendered props are empty because RSC data reads
  // bind RLS via enterWith, unreliable under app_rw (SAU-275). The API uses withActor
  // (runWithActor) and binds app.clinic_id reliably — the source of truth for this view.
  useEffect(() => {
    refresh()
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const res = await fetch('/api/use-cases/call-center-agent/dashboard', { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Failed to load dashboard.');
    const data = await res.json();
    setSwitcher(data.switcher);
    setMetrics(data.metrics);
  }

  async function switchLender(clinicId: string) {
    if (clinicId === switcher.activeClinicId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/use-cases/call-center-agent/lenders', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clinicId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Could not switch lender.');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createLender() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/use-cases/call-center-agent/lenders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Could not create lender.');
      setNewName('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hasLenders = switcher.clinics.length > 0;

  return (
    <div className="settings-section">
      <h1>Collections ops dashboard</h1>
      <p className="billing-muted">
        Per-lender cadence, next-eligible dial, suppression list and the compliance audit trail for the
        AI Call Center Agent. Each lender is fully isolated; switch lenders below. Showing test data —
        nothing here places a real call.
      </p>

      {/* ── Lender switcher ─────────────────────────────────────────────── */}
      <div className="settings-integration" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <strong>Lender:</strong>
        {hasLenders ? (
          <select
            className="settings-input"
            value={switcher.activeClinicId ?? ''}
            disabled={busy}
            onChange={(e) => switchLender(e.target.value)}
            aria-label="Active lender"
            style={{ maxWidth: 320 }}
          >
            {switcher.clinics.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        ) : loading ? (
          <span className="billing-muted">Loading lenders…</span>
        ) : (
          <span className="billing-muted">No lenders yet — create one to start.</span>
        )}
        <span style={{ flex: 1 }} />
        <input
          className="settings-input"
          placeholder="New lender name"
          value={newName}
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <button className="btn" onClick={createLender} disabled={busy || !newName.trim()}>
          + Add lender
        </button>
      </div>

      {error && <p className="billing-error">{error}</p>}

      {/* ── Metrics ─────────────────────────────────────────────────────── */}
      {loading ? (
        <p className="settings-pending-note">Loading dashboard…</p>
      ) : !hasLenders || !metrics ? (
        <p className="settings-pending-note">
          Create a lender and load a debtor list to populate this dashboard.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
            <Tile label="Debtors" value={String(metrics.totalDebtors)} />
            <Tile label="Eligible now" value={String(metrics.eligibleNow)} hint="cleared all compliance guardrails" />
            <Tile label="Suppressed" value={String(metrics.suppressed)} hint="opt-out or open dispute" />
            <Tile label="Attempts" value={String(metrics.totalAttempts)} hint="calls placed (excl. blocks)" />
            <Tile label="Contact rate" value={pct(metrics.contactRate)} hint="contacted + promised / placed" />
            <Tile label="Promises to pay" value={String(metrics.promisedToPay)} />
            <Tile label="Compliance blocks" value={String(metrics.blockedAttempts)} hint="dials the engine refused" />
          </div>

          {/* ── Cadence + next-eligible dial ──────────────────────────────── */}
          <h2 style={{ marginTop: 24 }}>Cadence & next eligible dial</h2>
          {metrics.cadence.length === 0 ? (
            <p className="billing-muted">No debtors loaded yet for this lender.</p>
          ) : (
            <table className="settings-integration-list" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Debtor</th>
                  <th style={{ padding: '6px 8px' }}>State</th>
                  <th style={{ padding: '6px 8px' }}>Attempts</th>
                  <th style={{ padding: '6px 8px' }}>Last outcome</th>
                  <th style={{ padding: '6px 8px' }}>Status / next eligible</th>
                </tr>
              </thead>
              <tbody>
                {metrics.cadence.map((r) => (
                  <tr key={r.debtorId} style={{ borderTop: '1px solid var(--border, #e5e7eb)' }}>
                    <td style={{ padding: '6px 8px' }}>{r.externalRef}</td>
                    <td style={{ padding: '6px 8px' }}>{r.state ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{r.attempts}</td>
                    <td style={{ padding: '6px 8px' }}>{r.lastOutcome ? OUTCOME_LABEL[r.lastOutcome] : '—'}</td>
                    <td style={{ padding: '6px 8px' }}><StatusCell row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* ── Suppression / opt-out list ────────────────────────────────── */}
          <h2 style={{ marginTop: 24 }}>Suppression / do-not-call list</h2>
          {metrics.suppressionList.length === 0 ? (
            <p className="billing-muted">No suppressed debtors for this lender.</p>
          ) : (
            <ul>
              {metrics.suppressionList.map((r) => (
                <li key={r.debtorId}>
                  <strong>{r.externalRef}</strong> — {r.optedOut ? 'opted out / do-not-call' : ''}
                  {r.optedOut && r.disputeOpen ? ' + ' : ''}
                  {r.disputeOpen ? 'open dispute (calling paused)' : ''}
                </li>
              ))}
            </ul>
          )}

          {/* ── Compliance-block counts ───────────────────────────────────── */}
          <h2 style={{ marginTop: 24 }}>Compliance blocks by reason</h2>
          {metrics.complianceBlocks.length === 0 ? (
            <p className="billing-muted">No dials have been blocked for this lender.</p>
          ) : (
            <ul>
              {metrics.complianceBlocks.map((b) => (
                <li key={b.reason}><code>{b.reason}</code> — {b.count}</li>
              ))}
            </ul>
          )}

          {/* ── Compliance audit trail (guardrail 10, read-only) ──────────── */}
          <h2 style={{ marginTop: 24 }}>Compliance audit trail</h2>
          <p className="billing-muted" style={{ marginTop: -8 }}>
            Read-only, append-only ledger — why each debtor was or wasn’t called.
          </p>
          {metrics.recentAudit.length === 0 ? (
            <p className="billing-muted">No audit events recorded yet for this lender.</p>
          ) : (
            <table className="settings-integration-list" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>When</th>
                  <th style={{ padding: '6px 8px' }}>Event</th>
                  <th style={{ padding: '6px 8px' }}>Decision</th>
                  <th style={{ padding: '6px 8px' }}>Reason</th>
                  <th style={{ padding: '6px 8px' }}>Debtor</th>
                  <th style={{ padding: '6px 8px' }}>Actor</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentAudit.map((a, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border, #e5e7eb)' }}>
                    <td style={{ padding: '6px 8px' }}>{fmt(a.ts)}</td>
                    <td style={{ padding: '6px 8px' }}>{a.eventType}</td>
                    <td style={{ padding: '6px 8px' }}>{a.decision ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{a.reason ? <code>{a.reason}</code> : '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{a.debtorRef}</td>
                    <td style={{ padding: '6px 8px' }}>{a.actorLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
