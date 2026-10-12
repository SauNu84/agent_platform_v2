'use client';

/**
 * Coach memory controls (ADR-004 §User controls) — the privacy-by-design surface:
 *   - the consent gate (two granular, independently-toggled switches),
 *   - the memory inspector (view what the coach remembers),
 *   - DSAR controls (delete one / wipe all / export JSON) — on EVERY plan,
 *   - the paused-memory notice (SAU-557 · CISO SAU-558 C5): when the plan no longer
 *     includes memory, nothing is used or added, nothing is deleted now, everything
 *     expires by the real latest `expires_at`, and delete-now is one click.
 * Talks to /api/coaches/[slug]/consent and /api/coaches/[slug]/memory.
 */
import { useState } from 'react';

interface ConsentState { persistentMemory: boolean; audioRetention: boolean; }
interface MemoryItem {
  id: string; kind: string; content: string; salience: number;
  sourceSessionId: string | null; expiresAt: string; createdAt: string;
}
type MemoryAccess = 'active' | 'paused' | 'no_consent' | 'anonymous';
interface Props {
  slug: string;
  coachName: string;
  initialConsent: ConsentState;
  initialMemories: MemoryItem[];
  initialAccess: MemoryAccess;
  /** real max(expires_at) of held memories while paused; null otherwise */
  initialPausedUntil: string | null;
  policy: { version: string; text: string };
}

export default function CoachMemoryPanel({
  slug, coachName, initialConsent, initialMemories, initialAccess, initialPausedUntil, policy,
}: Props) {
  const [consent, setConsent] = useState<ConsentState>(initialConsent);
  const [memories, setMemories] = useState<MemoryItem[]>(initialMemories);
  const [access, setAccess] = useState<MemoryAccess>(initialAccess);
  const [pausedUntil, setPausedUntil] = useState<string | null>(initialPausedUntil);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`/api/coaches/${slug}/memory`);
    const data = await res.json();
    if (res.ok) {
      setMemories(data.memories ?? []);
      if (data.access) setAccess(data.access);
      setPausedUntil(data.pausedUntil ?? null);
    }
  }

  async function toggle(consentType: 'persistent_memory' | 'audio_retention', current: boolean) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/coaches/${slug}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentType, action: current ? 'revoked' : 'granted' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      setConsent(data.state);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteOne(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/coaches/${slug}/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMemories((m) => m.filter((x) => x.id !== id));
    } finally {
      setBusy(false);
    }
  }

  async function wipeAll() {
    setBusy(true);
    try {
      await fetch(`/api/coaches/${slug}/memory`, { method: 'DELETE' });
      setMemories([]);
      setPausedUntil(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card-section memory-panel">
      <h2>Memory &amp; privacy</h2>
      <p className="subtitle">{policy.text}</p>

      <div className="consent-toggles">
        <label className="toggle">
          <input
            type="checkbox"
            checked={consent.persistentMemory}
            disabled={busy}
            onChange={() => toggle('persistent_memory', consent.persistentMemory)}
          />
          Remember my sessions with this coach
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={consent.audioRetention}
            disabled={busy}
            onChange={() => toggle('audio_retention', consent.audioRetention)}
          />
          Also keep my audio recordings (up to 90 days)
        </label>
      </div>
      {access === 'paused' && memories.length > 0 && (
        <div className="notice memory-paused" role="status">
          <p>
            <strong>Your coach memories are paused.</strong> {coachName} won&apos;t use or add to them while
            your plan doesn&apos;t include coach memory. Nothing is deleted now — memories expire on their normal
            schedule (summaries after 12 months; other memories after 24 months unused)
            {pausedUntil ? <>, all gone by <strong>{new Date(pausedUntil).toLocaleDateString()}</strong></> : null}.
            {' '}<a href="/billing?trigger=coach_memory">Upgrade any time</a> to pick up where you left off.
          </p>
          <p>
            <button className="btn danger" onClick={wipeAll} disabled={busy}>Delete my memories now</button>
            {' · '}
            <button className="btn" onClick={() => window.open(`/api/coaches/${slug}/memory`, '_blank')} disabled={busy}>
              View / export
            </button>
          </p>
        </div>
      )}
      {!consent.persistentMemory && (
        <p className="notice">Memory is off — sessions run, but nothing is remembered for next time.</p>
      )}
      {error && <p className="notice" role="alert">{error}</p>}

      <div className="memory-actions">
        <button className="btn" onClick={refresh} disabled={busy}>Refresh</button>
        <button className="btn" onClick={() => window.open(`/api/coaches/${slug}/memory`, '_blank')} disabled={busy}>
          Export (JSON)
        </button>
        <button className="btn danger" onClick={wipeAll} disabled={busy || memories.length === 0}>
          Wipe all memory
        </button>
      </div>

      <h3>What this coach remembers ({memories.length})</h3>
      {memories.length === 0 ? (
        <p className="empty">Nothing remembered yet. Grant memory, then run a session.</p>
      ) : (
        <table>
          <thead><tr><th>Kind</th><th>Content</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {memories.map((m) => (
              <tr key={m.id}>
                <td>{m.kind}</td>
                <td>{m.content}</td>
                <td>{new Date(m.expiresAt).toLocaleDateString()}</td>
                <td><button className="btn small danger" onClick={() => deleteOne(m.id)} disabled={busy}>delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="policy-version">Policy version {policy.version}</p>
    </section>
  );
}
