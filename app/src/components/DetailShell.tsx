'use client';

/**
 * Shared entity detail shell — Details / Sessions / Analytics tabs over an avatar,
 * Overview, Your Instructions, and a Join action. This is the SAME shell the
 * reference product reuses for Scenario, Coach, and in-course scenario detail
 * (design §intro: "identical detail shell"). It is intentionally generic — it
 * takes serializable content + a sessions endpoint — so Slice 3 (Coach/Course)
 * reuses it without change.
 */
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RubricItem } from '@/domain/scenario';
import ChatPanel from './ChatPanel';
import GetReadyPanel from './GetReadyPanel';
import { aiModelLabel, aiModelById } from '@/lib/ai-models';

/** Subset of the SAU-257 voice meter the detail surface renders. */
interface VoiceMeter {
  remainingMinutes: number;
  capMinutes: number;
  sessionMaxMinutes: number | null;
  overCap: boolean;
  resetsAt: string;
  tier: 'free' | 'paid';
}

const fmtMin = (m: number) => (Number.isInteger(m) ? `${m}` : m.toFixed(1));

/**
 * Render a learner-facing field as formatted Markdown (SAU-246). The reference
 * product's scenario detail is a clean briefing — headings, numbered steps, a
 * comparison table — not a monospace prompt dump. GFM gives us tables + lists.
 */
function Brief({ text }: { text: string }) {
  return (
    <div className="brief">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

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
  /** Whether the scenario is publicly listed (SAU-246: surfaced as a config chip). */
  isPublic?: boolean;
  /**
   * Knowledge Bases linked to this scenario (SAU-243). The settings form lets you
   * link reusable corpora, but the detail page never reflected them (SAU-246) —
   * we now list them so the configured grounding is visible to the reader.
   */
  knowledgeBases?: Array<{ id: string; title: string; description: string | null; docCount: number }>;
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
  // Pre-join "Get Ready" screen (SAU-344) — the non-gated half of the live-voice
  // UX. Avatar-led, sends NO audio to any vendor, and routes "Join Now" into the
  // honestly-labelled simulated recap (SAU-217). The live in-session dock (real
  // mic round-trip) stays in SAU-218, gated on SAU-208 + Gate-2 DPA (SAU-221).
  const [getReadyOpen, setGetReadyOpen] = useState(false);
  // Voice-minute cap (SAU-257): the live meter + a graceful "cap reached" state.
  // When the monthly voice budget is spent, voice is blocked and we steer the
  // learner into unlimited text Chat + an upgrade CTA — never a crash/silent fail.
  const [voiceMeter, setVoiceMeter] = useState<VoiceMeter | null>(null);
  const [capReached, setCapReached] = useState(false);
  // SAU-238: the human learner's brief (UI only, never sent to the model).
  const userInstructions = typeof props.metadata?._userInstructions === 'string' ? props.metadata._userInstructions : '';
  // SAU-238 ask #5: the AI persona identity ("Description for AI"), prepended to
  // the system prompt. It shapes the agent, so SAU-246 surfaces it on detail.
  const aiPersona = typeof props.metadata?._aiDescription === 'string' ? props.metadata._aiDescription : '';
  // SAU-238 ask #6 → SAU-258: which voice engine this scenario runs on.
  const aiModelId = typeof props.metadata?._model === 'string' ? props.metadata._model : '';
  const aiModel = aiModelId ? aiModelLabel(aiModelId) : '';
  const aiModelOption = aiModelId ? aiModelById(aiModelId) : null;
  // Human-readable scenario taxonomy (role / difficulty), pulled out of metadata
  // for the at-a-glance config strip (SAU-246).
  const role = typeof props.metadata?.role === 'string' ? props.metadata.role : '';
  const difficulty = typeof props.metadata?.difficulty === 'string' ? props.metadata.difficulty : '';
  const knowledgeBases = props.knowledgeBases ?? [];
  // SAU-238 ask #7: reference context attached to ground the agent.
  const aiContext = typeof props.metadata?._aiContext === 'string' ? props.metadata._aiContext : '';
  const aiContextSource = typeof props.metadata?._aiContextSource === 'string' ? props.metadata._aiContextSource : '';
  // SAU-238 ask #10: optional custom avatar image (Appearance).
  const avatarUrl = typeof props.metadata?._avatarUrl === 'string' && /^https?:\/\//.test(props.metadata._avatarUrl) ? props.metadata._avatarUrl : '';
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

  // Live voice-minute meter for the remaining-minutes hint (SAU-257). Best-effort:
  // a failed/anon read just hides the hint — it never blocks the page.
  useEffect(() => {
    let live = true;
    fetch('/api/voice/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d?.meter) { setVoiceMeter(d.meter); setCapReached(!!d.meter.overCap); } })
      .catch(() => {});
    return () => { live = false; };
  }, []);

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
      // Voice-minute cap reached (SAU-257): block voice gracefully → text Chat
      // fallback + upgrade CTA. The 402 carries the meter so we can explain it.
      if (res.status === 402) {
        if (data.meter) setVoiceMeter(data.meter);
        setCapReached(true);
        return;
      }
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

  // Pre-join "Get Ready" screen (SAU-344). Avatar-led, mic-free pre-flight. "Join
  // Now" runs the simulated session through join() and closes this panel; the
  // inline simulated recap (the liveSession branch below) then renders the result.
  if (getReadyOpen) {
    return (
      <GetReadyPanel
        name={props.name}
        category={String(props.metadata?.role ?? props.metadata?.category ?? props.kind)}
        slug={props.slug}
        avatarUrl={avatarUrl}
        personaLine={aiPersona || props.overview || undefined}
        joining={joining}
        onJoin={async () => {
          await join();
          setGetReadyOpen(false);
        }}
        onClose={() => setGetReadyOpen(false)}
      />
    );
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
        {/* SAU-344/SAU-217: honest framing. The simulated recap must never read as
            a live mic-based run. When the session came from the mock vendor (no
            user audio sent anywhere), say so plainly. */}
        {liveSession.vendor === 'mock' && (
          <div className="notice session-demo-banner" role="status">
            <strong>Simulated demo.</strong> This is a self-scripted walkthrough — no microphone was
            used and no audio was sent anywhere. Live mic-based voice is the next increment.
          </div>
        )}
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
        {avatarUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img className="avatar" src={avatarUrl} alt="" style={{ objectFit: 'cover' }} />
          : <div className="avatar" aria-hidden />}
        <div style={{ flex: 1 }}>
          <h1>{props.name}</h1>
          {/* SAU-246: a quiet, learner-facing subtitle — the scenario kind plus
              its role/difficulty. Authoring config (model, voice, visibility)
              moved out of the headline into the collapsed setup section below. */}
          <p className="subtitle">
            {props.kind}{role ? ` · ${role}` : ''}{difficulty ? ` · ${difficulty}` : ''}
          </p>
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
            // SAU-344: the scenario detail surface offers a simulated practice
            // **demo** (via the mic-free "Get Ready" pre-join screen → join()'s
            // deterministic simulated recap, SAU-217) AND a text Chat. The live
            // in-session voice dock (real mic round-trip) is carved into SAU-218,
            // gated on SAU-208 (live-mic E2E) + Gate-2 DPA (SAU-221) — so it is
            // intentionally NOT surfaced here as a control.
            <>
              <button
                className="btn btn-secondary"
                onClick={() => { setError(null); if (capReached) { setChatOpen(true); } else { setGetReadyOpen(true); } }}
                disabled={capReached}
                title={capReached
                  ? 'You’ve used your voice minutes this month — continue in text Chat'
                  : 'See a short simulated practice session — no microphone needed yet'}
              >
                ▶ Try demo
              </button>
              <button className="btn join" onClick={() => { setError(null); setChatOpen(true); }}>
                💬 Chat
              </button>
            </>
          ) : (
            // Coach / Course surfaces (no text chat): Join opens the same mic-free
            // "Get Ready" pre-join screen (SAU-344), which runs the simulated recap.
            <button className="btn join" onClick={() => { setError(null); setGetReadyOpen(true); }} disabled={joining || capReached}>
              {joining ? 'Connecting…' : capReached ? 'Voice cap reached' : 'Join'}
            </button>
          )}
        </div>
      </div>
      {/* Remaining-minutes hint (SAU-257) — free tier only, when not yet capped. */}
      {voiceMeter && voiceMeter.tier === 'free' && !capReached && (
        <p className="voice-minutes-hint billing-muted">
          🎙 {fmtMin(voiceMeter.remainingMinutes)} of {fmtMin(voiceMeter.capMinutes)} voice minutes left this month
          {voiceMeter.sessionMaxMinutes != null ? ` · up to ${fmtMin(voiceMeter.sessionMaxMinutes)} min/session` : ''}.
          {' '}Text Chat is always unlimited.
        </p>
      )}
      {/* Voice cap reached (SAU-257) — graceful fallback, no hard paywall. */}
      {capReached && (
        <div className="notice voice-cap-notice" role="status">
          <strong>You&apos;ve used your voice minutes this month.</strong>{' '}
          {voiceMeter ? <>Your free allowance ({fmtMin(voiceMeter.capMinutes)} min) resets {new Date(voiceMeter.resetsAt).toLocaleDateString()}. </> : null}
          Keep practicing in unlimited text Chat — or upgrade for more voice time.
          <div className="voice-cap-actions">
            <button className="btn join" onClick={() => { setError(null); setChatOpen(true); }}>💬 Continue in Chat</button>
            <a className="btn btn-secondary" href="/billing?trigger=cap_reached">Upgrade for more voice</a>
          </div>
        </div>
      )}
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
          // SAU-246 (board: "easy for user to understand, not much configuration"):
          // the detail page is now a LEARNER briefing, mirroring the reference
          // product — Overview + Your Instructions rendered as clean Markdown.
          // All authoring config (AI prompt/persona, model, voice, rubric weights,
          // KBs, metadata) is tucked into a collapsed "Scenario setup" disclosure
          // so it's available to authors without cluttering the practitioner view.
          // The AI Instructions are also the "answer key" — hiding them by default
          // keeps the roleplay honest.
          <>
            <h2>Overview</h2>
            {props.overview
              ? <Brief text={props.overview} />
              : <p className="empty">No description.</p>}

            {userInstructions && (
              <>
                <h2>Your Instructions</h2>
                <Brief text={userInstructions} />
              </>
            )}

            <details className="setup">
              <summary>⚙️ Scenario setup <span className="setup-hint">— how this scenario is configured (for authors)</span></summary>
              <div className="setup-body">
                <dl className="kv">
                  <div style={{ display: 'contents' }}><dt>Visibility</dt><dd>{props.isPublic ? 'Public' : 'Private'}</dd></div>
                  {role && <div style={{ display: 'contents' }}><dt>Role</dt><dd>{role}</dd></div>}
                  {difficulty && <div style={{ display: 'contents' }}><dt>Difficulty</dt><dd>{difficulty}</dd></div>}
                  {aiModel && <div style={{ display: 'contents' }}><dt>AI model</dt><dd>{aiModel}{aiModelOption?.note && <span className="setup-hint"> — {aiModelOption.note}</span>}</dd></div>}
                  <div style={{ display: 'contents' }}><dt>Voice</dt><dd>{props.voice.name} ({props.voice.languageCode})</dd></div>
                  {Object.entries(props.metadata)
                    .filter(([k]) => !k.startsWith('_') && k !== 'role' && k !== 'difficulty')
                    .map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{String(v)}</dd></div>
                    ))}
                </dl>

                {aiPersona && (
                  <>
                    <h3>AI Persona</h3>
                    <div className="instructions">{aiPersona}</div>
                  </>
                )}

                <h3>AI Instructions <span className="setup-hint">— the system prompt the agent follows (answer key)</span></h3>
                <div className="instructions">{props.instructions}</div>

                {aiContext && (
                  <>
                    <h3>Additional Context for AI</h3>
                    <p className="empty" style={{ fontStyle: 'normal' }}>
                      {aiContextSource ? <>Grounded on {/^https?:\/\//.test(aiContextSource)
                        ? <a href={aiContextSource} target="_blank" rel="noreferrer">{aiContextSource}</a>
                        : <strong>{aiContextSource}</strong>} · </> : null}
                      {aiContext.length.toLocaleString()} chars folded into the system prompt.
                    </p>
                  </>
                )}

                {knowledgeBases.length > 0 && (
                  <>
                    <h3>Knowledge Bases</h3>
                    <ul className="kb-list">
                      {knowledgeBases.map((kb) => (
                        <li key={kb.id} className="kb-list-item">
                          <span className="kb-list-title">📚 {kb.title}</span>
                          <span className="empty" style={{ fontStyle: 'normal' }}>
                            {kb.docCount} doc{kb.docCount === 1 ? '' : 's'}{kb.description ? ` · ${kb.description}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {props.rubric.length > 0 && (
                  <>
                    <h3>Rubric</h3>
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
              </div>
            </details>
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
