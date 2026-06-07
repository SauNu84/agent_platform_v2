'use client';

/**
 * Shared entity detail shell — Details / Sessions / Analytics tabs over an avatar,
 * Overview, Your Instructions, and a Join action. This is the SAME shell the
 * reference product reuses for Scenario, Coach, and in-course scenario detail
 * (design §intro: "identical detail shell"). It is intentionally generic — it
 * takes serializable content + a sessions endpoint — so Slice 3 (Coach/Course)
 * reuses it without change.
 */
import { useState } from 'react';
import type { RubricItem } from '@/domain/scenario';

export interface SessionSummary {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  turns: Array<{ role: 'user' | 'agent'; text: string; at: number }>;
}

export interface DetailShellProps {
  kind: string;
  slug: string;
  name: string;
  overview: string | null;
  instructions: string;
  rubric: RubricItem[];
  metadata: Record<string, unknown>;
  voice: { name: string; languageCode: string };
  initialSessions: SessionSummary[];
  sessionsEndpoint: string;
}

type Tab = 'details' | 'sessions' | 'analytics';

export default function DetailShell(props: DetailShellProps) {
  const [tab, setTab] = useState<Tab>('details');
  const [sessions, setSessions] = useState<SessionSummary[]>(props.initialSessions);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setJoining(true);
    setError(null);
    try {
      const res = await fetch(props.sessionsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      const summary: SessionSummary = {
        id: data.sessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        turns: data.transcript?.turns ?? [],
      };
      setSessions((s) => [summary, ...s]);
      setTab('sessions');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJoining(false);
    }
  }

  return (
    <div>
      <div className="detail-head">
        <div className="avatar" aria-hidden />
        <div style={{ flex: 1 }}>
          <h1>{props.name}</h1>
          <p className="subtitle">{props.kind} · voice {props.voice.name} ({props.voice.languageCode})</p>
        </div>
        <button className="btn join" onClick={join} disabled={joining}>
          {joining ? 'Connecting…' : 'Join'}
        </button>
      </div>
      {error && <div className="notice" role="alert">Join failed: {error}</div>}

      <div className="tabs" role="tablist">
        {(['details', 'sessions', 'analytics'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'details' ? 'Details' : t === 'sessions' ? `Sessions${sessions.length ? ` (${sessions.length})` : ''}` : 'Analytics'}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === 'details' && (
          <>
            <h2>Overview</h2>
            <div className="overview">{props.overview || <span className="empty">No description.</span>}</div>

            <h2>Your Instructions</h2>
            <div className="instructions">{props.instructions}</div>

            {props.rubric.length > 0 && (
              <>
                <h2>Rubric</h2>
                <table>
                  <thead><tr><th>Topic</th><th>Weight</th><th>Note</th></tr></thead>
                  <tbody>
                    {props.rubric.map((r, i) => (
                      <tr key={i}><td>{r.topic}</td><td>{r.weight}</td><td>{r.note ?? ''}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {Object.keys(props.metadata).length > 0 && (
              <>
                <h2>Metadata</h2>
                <dl className="kv">
                  {Object.entries(props.metadata).map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{k}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </>
        )}

        {tab === 'sessions' && (
          sessions.length === 0 ? (
            <p className="empty">No sessions yet. Click Join to run a live voice session.</p>
          ) : (
            <table>
              <thead><tr><th>Started</th><th>Status</th><th>Turns</th><th>Transcript</th></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.startedAt).toLocaleString()}</td>
                    <td>{s.status}</td>
                    <td>{s.turns.length}</td>
                    <td>
                      {s.turns.length === 0 ? <span className="empty">—</span> : (
                        <details>
                          <summary>view</summary>
                          <div className="transcript">
                            {s.turns.map((t, i) => (
                              <div className="turn" key={i}><span className="role">{t.role}</span>{t.text}</div>
                            ))}
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === 'analytics' && (
          <p className="empty">Rubric-scored analytics land in Slice 2 (Analyst). Sessions are already being captured and metered.</p>
        )}
      </div>
    </div>
  );
}
