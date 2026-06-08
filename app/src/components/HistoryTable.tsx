'use client';

/**
 * Session History table (client) — filterable list with Analyze / Restore /
 * Export CSV actions. Analyze runs the Analyst worker for a row and shows the
 * returned report inline; Restore re-opens the scenario to practice again; Export
 * downloads the current (filtered) view as CSV.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { SessionHistoryRow } from '@/db/store';
import type { AnalysisRecord } from '@/domain/analysis';
import AnalysisReport from './AnalysisReport';

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${(total % 60).toString().padStart(2, '0')}s`;
}

export default function HistoryTable({ initialRows }: { initialRows: SessionHistoryRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [scenario, setScenario] = useState('');
  const [status, setStatus] = useState('');
  const [reports, setReports] = useState<Record<string, AnalysisRecord>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scenarioOptions = useMemo(
    () => [...new Set(initialRows.map((r) => r.scenarioSlug))].filter(Boolean),
    [initialRows],
  );

  const filtered = rows.filter((r) => {
    if (scenario && r.scenarioSlug !== scenario) return false;
    if (status && r.status !== status) return false;
    return true;
  });

  async function analyze(sessionId: string) {
    setBusy(sessionId);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/analyze`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
      setReports((m) => ({ ...m, [sessionId]: data.analysis }));
      setRows((rs) => rs.map((r) => (r.sessionId === sessionId
        ? { ...r, analyzed: true, finalScore: data.analysis.evaluation.finalScore }
        : r)));
      setOpen(sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const csvHref = (() => {
    const sp = new URLSearchParams({ format: 'csv' });
    if (scenario) sp.set('scenario', scenario);
    if (status) sp.set('status', status);
    return `/api/history?${sp.toString()}`;
  })();

  return (
    <div>
      <div className="filters">
        <select value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="Filter by scenario">
          <option value="">All scenarios</option>
          {scenarioOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">Any status</option>
          <option value="completed">Completed</option>
          <option value="active">Active</option>
          <option value="failed">Failed</option>
        </select>
        <a className="btn-sm" href={csvHref}>Export CSV</a>
      </div>

      {error && <div className="notice" role="alert">{error}</div>}

      {filtered.length === 0 ? (
        <p className="empty">No sessions yet. Run a scenario from the Library to build history.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Scenario</th><th>Started</th><th>Duration</th><th>Status</th><th>Score</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.sessionId}>
                <td>{r.scenarioName}</td>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
                <td>{fmtDuration(r.durationMs)}</td>
                <td>{r.status}</td>
                <td>{r.analyzed && r.finalScore !== null ? Math.round(r.finalScore) : '—'}</td>
                <td className="actions">
                  <button
                    className="btn-sm"
                    disabled={busy === r.sessionId || r.status !== 'completed'}
                    onClick={() => (reports[r.sessionId] ? setOpen(open === r.sessionId ? null : r.sessionId) : analyze(r.sessionId))}
                    title={r.status !== 'completed' ? 'Only completed sessions can be analyzed' : ''}
                  >
                    {busy === r.sessionId ? 'Analyzing…' : reports[r.sessionId] ? (open === r.sessionId ? 'Hide' : 'View report') : 'Analyze'}
                  </button>
                  {r.scenarioSlug && (
                    <Link className="btn-sm" href={`/scenarios/${r.scenarioSlug}`}>Restore</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && reports[open] && (
        <div className="report-panel">
          <AnalysisReport analysis={reports[open]} />
        </div>
      )}
    </div>
  );
}
