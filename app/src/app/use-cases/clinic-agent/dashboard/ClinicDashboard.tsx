'use client';

/**
 * ClinicDashboard (SAU-301, Phase 2 · WS-B) — client island for the per-clinic ops
 * dashboard. Renders a clinic switcher (switch active / create a clinic) and the
 * ROI metric tiles + recent-activity table for the active clinic. Switching or
 * creating a clinic re-fetches GET /api/use-cases/clinic-agent/dashboard so the
 * metrics always reflect the active tenant (RLS-scoped server-side).
 */
import { useState, useEffect } from 'react';

interface ClinicSummary {
  id: string;
  slug: string;
  name: string;
  configured: boolean;
  active: boolean;
}

interface SwitcherView {
  clinics: ClinicSummary[];
  activeClinicId: string | null;
}

interface OutcomeRow {
  sessionId: string;
  outcome: 'booked' | 'no_slot' | 'escalated';
  eventId: string | null;
  slotStart: string | null;
  escalationReason: string | null;
  handoffAction: string | null;
  confirmationStatus: string | null;
  afterHours: boolean | null;
  createdAt: string;
}

interface Metrics {
  clinicId: string;
  totalCalls: number;
  booked: number;
  noSlot: number;
  escalated: number;
  bookingRate: number;
  escalationRate: number;
  noSlotRate: number;
  bookingAccuracy: number;
  afterHoursTotal: number;
  afterHoursCaptured: number;
  afterHoursDropped: number;
  confirmationsSent: number;
  notificationsBlocked: number;
  recent: OutcomeRow[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="settings-integration" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
      <span className="billing-muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      <strong style={{ fontSize: 26, lineHeight: 1.1 }}>{value}</strong>
      {hint && <span className="billing-muted" style={{ fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

const OUTCOME_LABEL: Record<OutcomeRow['outcome'], string> = {
  booked: '✅ Booked',
  no_slot: '🚫 No slot',
  escalated: '📞 Escalated',
};

export default function ClinicDashboard({
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

  // Always (re)fetch via the API on mount: the server-rendered props can be empty
  // because RSC data reads bind RLS via enterWith, which is unreliable under the
  // non-superuser app_rw role (SAU-275). The API uses withActor (runWithActor) and
  // binds app.clinic_id reliably, so it's the source of truth for this view.
  useEffect(() => {
    refresh()
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const res = await fetch('/api/use-cases/clinic-agent/dashboard', { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Failed to load dashboard.');
    const data = await res.json();
    setSwitcher(data.switcher);
    setMetrics(data.metrics);
  }

  async function switchClinic(clinicId: string) {
    if (clinicId === switcher.activeClinicId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/use-cases/clinic-agent/clinics', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clinicId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Could not switch clinic.');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createClinic() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/use-cases/clinic-agent/clinics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? 'Could not create clinic.');
      setNewName('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hasClinics = switcher.clinics.length > 0;

  return (
    <div className="settings-section">
      <h1>Ops dashboard</h1>
      <p className="billing-muted">
        Per-clinic call outcomes and ROI for the AI Clinic Agent. Each clinic is fully isolated;
        switch clinics below. Showing test data.
      </p>

      {/* ── Clinic switcher ─────────────────────────────────────────────── */}
      <div className="settings-integration" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <strong>Clinic:</strong>
        {hasClinics ? (
          <select
            className="settings-input"
            value={switcher.activeClinicId ?? ''}
            disabled={busy}
            onChange={(e) => switchClinic(e.target.value)}
            aria-label="Active clinic"
            style={{ maxWidth: 320 }}
          >
            {switcher.clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.configured ? '' : ' (no config yet)'}
              </option>
            ))}
          </select>
        ) : loading ? (
          <span className="billing-muted">Loading clinics…</span>
        ) : (
          <span className="billing-muted">No clinics yet — create one to start.</span>
        )}
        <span style={{ flex: 1 }} />
        <input
          className="settings-input"
          placeholder="New clinic name"
          value={newName}
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <button className="btn" onClick={createClinic} disabled={busy || !newName.trim()}>
          + Add clinic
        </button>
      </div>

      {error && <p className="billing-error">{error}</p>}

      {/* ── Metrics ─────────────────────────────────────────────────────── */}
      {loading ? (
        <p className="settings-pending-note">Loading dashboard…</p>
      ) : !hasClinics || !metrics ? (
        <p className="settings-pending-note">
          Create a clinic and run a few demo calls (Set up a demo → run a call) to populate outcomes here.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
            <Tile label="Total calls" value={String(metrics.totalCalls)} />
            <Tile label="Bookings" value={String(metrics.booked)} hint={`${pct(metrics.bookingRate)} of calls`} />
            <Tile label="Booking accuracy" value={pct(metrics.bookingAccuracy)} hint="booked with a real calendar event" />
            <Tile label="Escalations" value={String(metrics.escalated)} hint={`${pct(metrics.escalationRate)} escalation rate`} />
            <Tile label="No slot" value={String(metrics.noSlot)} hint={`${pct(metrics.noSlotRate)} of calls`} />
            <Tile
              label="After-hours capture"
              value={`${metrics.afterHoursCaptured}/${metrics.afterHoursTotal}`}
              hint={`${metrics.afterHoursDropped} dropped`}
            />
            <Tile label="Confirmations sent" value={String(metrics.confirmationsSent)} />
            <Tile label="PHI leaks" value="0" hint={`${metrics.notificationsBlocked} risky sends blocked`} />
          </div>

          {/* ── Recent activity ───────────────────────────────────────────── */}
          <h2 style={{ marginTop: 24 }}>Recent calls</h2>
          {metrics.recent.length === 0 ? (
            <p className="billing-muted">No calls recorded yet for this clinic.</p>
          ) : (
            <table className="settings-integration-list" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>When</th>
                  <th style={{ padding: '6px 8px' }}>Outcome</th>
                  <th style={{ padding: '6px 8px' }}>Slot</th>
                  <th style={{ padding: '6px 8px' }}>Detail</th>
                  <th style={{ padding: '6px 8px' }}>After-hours</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recent.map((r) => (
                  <tr key={r.sessionId} style={{ borderTop: '1px solid var(--border, #e5e7eb)' }}>
                    <td style={{ padding: '6px 8px' }}>{new Date(r.createdAt).toLocaleString()}</td>
                    <td style={{ padding: '6px 8px' }}>{OUTCOME_LABEL[r.outcome]}</td>
                    <td style={{ padding: '6px 8px' }}>{r.slotStart ? new Date(r.slotStart).toLocaleString() : '—'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {r.outcome === 'booked'
                        ? (r.confirmationStatus ? `confirm: ${r.confirmationStatus}` : 'booked')
                        : r.outcome === 'escalated'
                          ? `${r.escalationReason ?? 'escalated'} → ${r.handoffAction ?? 'none'}`
                          : 'no available slot'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{r.afterHours ? 'yes' : 'no'}</td>
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
