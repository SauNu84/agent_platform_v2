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
import ChatPanel from './ChatPanel';

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
  /**
   * When set, this surface offers a text **Chat** with the persona (SAU-224)
   * alongside the live voice **demo** (board direction 2026-06-10: surface both).
   * Surfaces that don't pass this (Coach/Course) keep the single Join CTA.
   */
  chatEndpoint?: string;
  /**
   * When set, a **Share** button mints (or returns) a stable short link to this
   * entity and copies it to the clipboard (SAU-225). Only public scenarios pass
   * this; the endpoint answers 403 for private ones and we surface that note.
   */
  shareEndpoint?: string;
  /**
   * When set, a **Remix** button clones this scenario's config into a new editable
   * draft owned by the current user (SAU-226). It links to the Scenario Studio
   * create form pre-filled from the source (`/scenarios/create?remix={slug}`).
   */
  remixHref?: string;
}

type Tab = 'details' | 'sessions' | 'analytics';

interface LiveSession { sessionId: string; turns: SessionSummary['turns']; startedAt: string; vendor: string; }

export default function DetailShell(props: DetailShellProps) {
  const [tab, setTab] = useState<Tab>('details');
  const [sessions, setSessions] = useState<SessionSummary[]>(props.initialSessions);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After join: show transcript inline so the board sees the interview/discussion result.
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
  // Text chat overlay (SAU-224) — replaces the live/simulated demo on this surface.
  const [chatOpen, setChatOpen] = useState(false);
  // Share short link (SAU-225) — confirmation (the copied URL) + busy/error state.
  const [shareInfo, setShareInfo] = useState<{ url: string; copied: boolean } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  // Upsert a session into the list so the Sessions tab + count stay live as a chat
  // conversation grows (each turn re-persists the same session id).
  function upsertSession(summary: SessionSummary) {
    setSessions((s) => {
      const idx = s.findIndex((x) => x.id === summary.id);
      if (idx === -1) return [summary, ...s];
      const next = [...s];
      next[idx] = summary;
      return next;
    });
  }

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
      const turns: SessionSummary['turns'] = data.transcript?.turns ?? [];
      setLiveSession({
        sessionId: data.sessionId,
        turns,
        startedAt: new Date().toISOString(),
        vendor: data.usage?.vendor ?? 'mock',
      });
      setSessions((s) => [{
        id: data.sessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        turns,
      }, ...s]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJoining(false);
    }
  }

  // Share (SAU-225): mint/return the stable short link and copy it to the clipboard.
  async function share() {
    if (!props.shareEndpoint) return;
    setSharing(true);
    setShareError(null);
    setShareInfo(null);
    try {
      const res = await fetch(props.shareEndpoint, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      const url = `${window.location.origin}${data.path}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // Clipboard can be blocked (no focus / insecure context); still show the URL.
      }
      setShareInfo({ url, copied });
    } catch (e) {
      setShareError((e as Error).message);
    } finally {
      setSharing(false);
    }
  }

  // Text chat overlay (SAU-224) — discuss with the persona over text.
  if (chatOpen && props.chatEndpoint) {
    return (
      <div className="session-view">
        <ChatPanel
          name={props.name}
          chatEndpoint={props.chatEndpoint}
          onClose={() => setChatOpen(false)}
          onSession={upsertSession}
        />
      </div>
    );
  }

  // Show the inline conversation view after a session completes.
  if (liveSession) {
    return (
      <div className="session-view">
        <nav className="session-nav">
          <button className="back-link" onClick={() => setLiveSession(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            ← {props.name}
          </button>
          <span className="session-meta">
            {new Date(liveSession.startedAt).toLocaleString()} · {liveSession.turns.length} turn{liveSession.turns.length === 1 ? '' : 's'}
            {liveSession.vendor === 'mock' ? ' · mock mode' : ` · ${liveSession.vendor}`}
          </span>
        </nav>
        <h1 className="session-title">{props.name}</h1>
        <p className="subtitle">Practice session</p>
        {liveSession.turns.length === 0 ? (
          <div className="session-empty">
            <p>Session ran but produced no transcript turns. Try again or check the voice adapter.</p>
            <button className="btn" onClick={() => setLiveSession(null)}>Back to details</button>
          </div>
        ) : (
          <div className="conversation">
            {liveSession.turns.map((turn, i) => (
              <div key={i} className={`turn turn-${turn.role}`}>
                <div className="turn-role">{turn.role === 'agent' ? 'AI' : 'You'}</div>
                <div className="turn-text">{turn.text}</div>
              </div>

            ))}
          </div>
        )}
        <div className="session-actions">
          <button className="btn" onClick={join} disabled={joining}>
            {joining ? 'Connecting…' : 'Practice again'}
          </button>
          <button className="btn-ghost" onClick={() => { setLiveSession(null); setTab('sessions'); }} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            View all sessions
          </button>
        </div>
        {error && <div className="notice" role="alert">Join failed: {error}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="detail-head">
        <div className="avatar" aria-hidden />
        <div style={{ flex: 1 }}>
          <h1>{props.name}</h1>
          <p className="subtitle">{props.kind} · voice {props.voice.name} ({props.voice.languageCode})</p>
        </div>
        <div className="join-actions">
          {props.remixHref && (
            <a className="btn btn-secondary" href={props.remixHref} title="Clone this scenario into an editable copy you own">
              ⎘ Remix
            </a>
          )}
          {props.shareEndpoint && (
            <button className="btn btn-secondary" onClick={share} disabled={sharing} title="Create a shareable link">
              {sharing ? 'Sharing…' : '🔗 Share'}
            </button>
          )}
          {props.chatEndpoint ? (
            // Board direction (2026-06-10): the scenario detail surface offers BOTH
            // a live voice roleplay demo AND a text Chat. `join()` runs the
            // server-driven voice session through the seam — deterministic mock by
            // default, live OpenAI Realtime when keyed (real end-user audio at scale
            // stays gated by SAU-193/SAU-208).
            <>
              <button className="btn btn-secondary" onClick={join} disabled={joining} title="Run a live voice roleplay session">
                {joining ? 'Connecting…' : '🎙 Live demo'}
              </button>
              <button className="btn join" onClick={() => { setError(null); setChatOpen(true); }}>
                💬 Chat
              </button>
            </>
          ) : (
            <button className="btn join" onClick={join} disabled={joining}>
              {joining ? 'Connecting…' : 'Join'}
            </button>
          )}
        </div>
      </div>
      {error && <div className="notice" role="alert">Join failed: {error}</div>}
      {shareError && <div className="notice" role="alert">Share failed: {shareError}</div>}
      {shareInfo && (
        <div className="notice" role="status">
          {shareInfo.copied ? 'Link copied — share it with a friend: ' : 'Share this link: '}
          <a href={shareInfo.url}>{shareInfo.url}</a>
        </div>
      )}

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

            {Object.entries(props.metadata).filter(([k]) => !k.startsWith('_')).length > 0 && (
              <>
                <h2>Metadata</h2>
                <dl className="kv">
                  {Object.entries(props.metadata)
                    .filter(([k]) => !k.startsWith('_')) // hide internal provenance keys (_source, _rubricText, …)
                    .map(([k, v]) => (
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
            <p className="empty">
              {props.chatEndpoint
                ? 'No sessions yet. Start a Chat to have a conversation — it saves here as a session.'
                : 'No sessions yet. Click Join to run a live voice session.'}
            </p>
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
          <p className="empty">
            Rubric-scored reports and per-creator KPIs are live. Analyze any session from{' '}
            <a href="/history">History</a>, or see aggregate engagement in{' '}
            <a href="/analytics">Creator Analytics</a>.
          </p>
        )}
      </div>
    </div>
  );
}
