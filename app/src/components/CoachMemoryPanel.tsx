'use client';

/**
 * Coach memory controls (ADR-004 §User controls) — the privacy-by-design surface:
 *   - the consent gate (two granular, independently-toggled switches),
 *   - the memory inspector (view what the coach remembers),
 *   - DSAR controls (delete one / wipe all / export JSON).
 * Talks to /api/coaches/[slug]/consent and /api/coaches/[slug]/memory.
 */
import { useState } from 'react';

interface ConsentState { persistentMemory: boolean; audioRetention: boolean; }
interface MemoryItem {
  id: string; kind: string; content: string; salience: number;
  sourceSessionId: string | null; expiresAt: string; createdAt: string;
}
interface Props {
  slug: string;
  initialConsent: ConsentState;
  initialMemories: MemoryItem[];
  policy: { version: string; text: string };
}

export default function CoachMemoryPanel({ slug, initialConsent, initialMemories, policy }: Props) {
  const [consent, setConsent] = useState<ConsentState>(initialConsent);
  const [memories, setMemories] = useState<MemoryItem[]>(initialMemories);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`/api/coaches/${slug}/memory`);
    const data = await res.json();
    if (res.ok) setMemories(data.memories ?? []);
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
