/**
 * Creator Analytics page — KPI cards + per-scenario table + CSV export.
 * Server component over the aggregate read-model (sessions/usage per scenario).
 */
import { getStore } from '@/db';
import { getCreatorAnalytics } from '@/services/analytics';
import { getActor } from '@/services/current-user';
import { csvExportLockFor } from '@/services/paywall';

export const dynamic = 'force-dynamic';

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${(total % 60).toString().padStart(2, '0')}s`;
}

export default async function AnalyticsPage() {
  const store = getStore();
  const { rows, kpis } = await getCreatorAnalytics(store);
  // SAU-557: CSV export is a Premium feature; the API enforces it, this mirrors it.
  const csvUpgradeHref = await csvExportLockFor(store, (await getActor())?.userId ?? null);

  const cards = [
    { label: 'Scenarios', value: kpis.totalScenarios },
    { label: 'Sessions', value: kpis.totalSessions },
    { label: 'Avg sessions / scenario', value: kpis.avgSessionsPerScenario },
    { label: 'Avg session duration', value: fmtDuration(kpis.avgDurationMs) },
    { label: 'Voice minutes', value: kpis.totalVoiceMinutes.toFixed(1) },
  ];

  return (
    <div>
      <h1>Creator Analytics</h1>
      <p className="subtitle">Engagement across your scenarios.</p>

      <div className="kpi-grid">
        {cards.map((c) => (
          <div key={c.label} className="kpi-card">
            <div className="kpi-value">{c.value}</div>
            <div className="kpi-label">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="filters" style={{ justifyContent: 'flex-end' }}>
        {csvUpgradeHref ? (
          <a className="btn-sm" href={csvUpgradeHref} title="CSV export is included in Premium">Export CSV · Premium</a>
        ) : (
          <a className="btn-sm" href="/api/analytics/creator?format=csv">Export CSV</a>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="empty">No scenarios yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Scenario</th><th>Sessions</th><th>Avg duration</th><th>Voice minutes</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.scenarioId}>
                <td>{r.name}</td>
                <td>{r.sessions}</td>
                <td>{fmtDuration(r.avgDurationMs)}</td>
                <td>{r.totalVoiceMinutes.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
