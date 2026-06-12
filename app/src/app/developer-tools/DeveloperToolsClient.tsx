'use client';

/**
 * Developer Tools client island (SAU-252) — the interactive API Keys + Webhooks
 * panels. Generating a key reveals the plaintext ONCE in a copy-able banner
 * (the server keeps only the hash). Revoking a key / deleting a webhook hits the
 * REST routes and refreshes the server-rendered lists.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { WebhookRecord } from '@/db/store';

interface KeyView {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface EventOption {
  id: string;
  label: string;
  description: string;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export default function DeveloperToolsClient({
  initialKeys,
  initialWebhooks,
  events,
}: {
  initialKeys: KeyView[];
  initialWebhooks: WebhookRecord[];
  events: EventOption[];
}) {
  const router = useRouter();

  // ── API Keys ───────────────────────────────────────────────────────────
  const [keys, setKeys] = useState<KeyView[]>(initialKeys);
  const [keyName, setKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  async function createKey() {
    setCreatingKey(true);
    setKeyError(null);
    setRevealedKey(null);
    try {
      const res = await fetch('/api/developer/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create key.');
      setRevealedKey(json.plaintext);
      setKeys((prev) => [
        { id: json.id, name: json.name, keyPrefix: json.keyPrefix, lastUsedAt: null, revokedAt: null, createdAt: json.createdAt },
        ...prev,
      ]);
      setKeyName('');
    } catch (e) {
      setKeyError((e as Error).message);
    } finally {
      setCreatingKey(false);
    }
  }

  async function revokeKey(id: string) {
    const res = await fetch(`/api/developer/keys/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, revokedAt: new Date().toISOString() } : k)));
      router.refresh();
    }
  }

  // ── Webhooks ───────────────────────────────────────────────────────────
  const [webhooks, setWebhooks] = useState<WebhookRecord[]>(initialWebhooks);
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<string[]>([events[0]?.id ?? '']);
  const [creatingHook, setCreatingHook] = useState(false);
  const [hookError, setHookError] = useState<string | null>(null);

  function toggleEvent(id: string) {
    setSelectedEvents((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]));
  }

  async function createHook() {
    setCreatingHook(true);
    setHookError(null);
    try {
      const res = await fetch('/api/developer/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events: selectedEvents }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create webhook.');
      setWebhooks((prev) => [json, ...prev]);
      setUrl('');
    } catch (e) {
      setHookError((e as Error).message);
    } finally {
      setCreatingHook(false);
    }
  }

  async function deleteHook(id: string) {
    const res = await fetch(`/api/developer/webhooks/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      router.refresh();
    }
  }

  const activeKeys = keys.filter((k) => !k.revokedAt);

  return (
    <>
      {/* ── API Keys ─────────────────────────────────────────────────────── */}
      <section className="billing-section devtools-section">
        <h2>API Keys</h2>
        <p className="billing-muted">
          Generate a secret key to authenticate API requests. You can have multiple keys; revoke any that leak.
        </p>

        <div className="devtools-create-row">
          <input
            type="text"
            className="devtools-input"
            placeholder="Key name (e.g. Production server)"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            disabled={creatingKey}
          />
          <button type="button" className="btn" onClick={createKey} disabled={creatingKey}>
            {creatingKey ? 'Generating…' : '+ Generate API key'}
          </button>
        </div>
        {keyError && <p className="billing-error" role="alert">{keyError}</p>}

        {revealedKey && (
          <div className="devtools-reveal" role="status">
            <strong>Copy your new key now — it won&apos;t be shown again.</strong>
            <div className="devtools-reveal-row">
              <code className="devtools-secret">{revealedKey}</code>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => navigator.clipboard?.writeText(revealedKey)}
              >
                Copy
              </button>
            </div>
          </div>
        )}

        {activeKeys.length === 0 ? (
          <p className="billing-muted">No active API keys yet.</p>
        ) : (
          <table className="billing-table devtools-table">
            <thead>
              <tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revokedAt ? 'devtools-revoked' : ''}>
                  <td>{k.name}</td>
                  <td><code>{k.keyPrefix}</code></td>
                  <td>{fmtDate(k.createdAt)}</td>
                  <td>{k.lastUsedAt ? fmtDate(k.lastUsedAt) : '—'}</td>
                  <td className="num">
                    {k.revokedAt ? (
                      <span className="devtools-badge revoked">Revoked</span>
                    ) : (
                      <button type="button" className="btn-remove-text" onClick={() => revokeKey(k.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Webhooks ─────────────────────────────────────────────────────── */}
      <section className="billing-section devtools-section">
        <h2>Webhooks</h2>
        <p className="billing-muted">
          Receive a POST callback when events happen. Verify authenticity with the signing secret we generate.
        </p>

        <div className="devtools-hook-form">
          <input
            type="url"
            className="devtools-input"
            placeholder="https://your-app.com/webhooks/agent-platform"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={creatingHook}
          />
          <fieldset className="devtools-events">
            <legend>Events</legend>
            {events.map((ev) => (
              <label key={ev.id} className="devtools-event">
                <input
                  type="checkbox"
                  checked={selectedEvents.includes(ev.id)}
                  onChange={() => toggleEvent(ev.id)}
                />
                <span>
                  <code>{ev.id}</code> — {ev.description}
                </span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="btn" onClick={createHook} disabled={creatingHook}>
            {creatingHook ? 'Adding…' : '+ Add webhook endpoint'}
          </button>
        </div>
        {hookError && <p className="billing-error" role="alert">{hookError}</p>}

        {webhooks.length === 0 ? (
          <p className="billing-muted">No webhook endpoints yet.</p>
        ) : (
          <ul className="devtools-hook-list">
            {webhooks.map((w) => (
              <li key={w.id} className="devtools-hook">
                <div className="devtools-hook-head">
                  <code className="devtools-hook-url">{w.url}</code>
                  <button type="button" className="btn-remove-text" onClick={() => deleteHook(w.id)}>
                    Delete
                  </button>
                </div>
                <div className="devtools-hook-meta">
                  {w.events.map((e) => (
                    <span key={e} className="devtools-badge">{e}</span>
                  ))}
                </div>
                <div className="devtools-hook-secret">
                  Signing secret: <code>{w.secret}</code>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
