'use client';

/**
 * AI Model tab client island (SAU-259) — provision the provider API keys the
 * scenario engines use: OpenAI (Realtime voice + chat) and Google Gemini (Gemini
 * Live voice). On save the key is validated against the provider; a rejected key
 * is not stored. Keys are server-side only — the UI shows a masked last-4 and
 * never receives the raw key back.
 */
import { useState } from 'react';

interface ModelKeyView {
  provider: 'openai' | 'gemini';
  label: string;
  help: string;
  placeholder: string;
  configured: boolean;
  last4: string | null;
  envProvisioned: boolean;
  updatedAt: string | null;
}

type Feedback = { kind: 'ok' | 'warn' | 'error'; text: string };

function ProviderCard({ initial }: { initial: ModelKeyView }) {
  const [view, setView] = useState<ModelKeyView>(initial);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/settings/model-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: view.provider, key: input }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save the key.');
      setView(json.key);
      setInput('');
      if (json.validation?.status === 'valid') {
        setFeedback({ kind: 'ok', text: 'Key saved and verified with the provider.' });
      } else {
        setFeedback({
          kind: 'warn',
          text: json.validation?.message
            ? `Key saved, but ${json.validation.message}`
            : 'Key saved, but it could not be verified right now.',
        });
      }
    } catch (e) {
      setFeedback({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/settings/model-keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: view.provider }),
      });
      if (!res.ok) throw new Error('Could not remove the key.');
      setView({ ...view, configured: false, last4: null, updatedAt: null });
    } catch (e) {
      setFeedback({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const feedbackClass =
    feedback?.kind === 'error' ? 'billing-error' : feedback?.kind === 'warn' ? 'settings-badge pending' : 'billing-muted';

  return (
    <div className="settings-status-card" style={{ display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <strong>{view.label}</strong>
        {view.envProvisioned && <span className="settings-badge">Env active</span>}
        {!view.envProvisioned && view.configured && <span className="settings-badge pending">Saved · …{view.last4}</span>}
      </div>
      <p className="billing-muted">{view.help}</p>

      {view.envProvisioned && (
        <p className="billing-muted">
          A key for this provider is set in the server environment, which takes precedence. A key saved here is kept
          as a fallback but isn&apos;t used while the environment key is present.
        </p>
      )}

      <div className="settings-field">
        <label htmlFor={`key-${view.provider}`}>
          {view.configured ? `Replace ${view.label} API key` : `${view.label} API key`}
        </label>
        <input
          id={`key-${view.provider}`}
          type="password"
          autoComplete="off"
          className="settings-input"
          placeholder={view.placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
      </div>

      {feedback && <p className={feedbackClass} role={feedback.kind === 'error' ? 'alert' : undefined}>{feedback.text}</p>}

      <div className="settings-actions">
        <button type="button" className="btn" onClick={save} disabled={busy || !input.trim()}>
          {busy ? 'Validating…' : view.configured ? 'Update key' : 'Save key'}
        </button>
        {view.configured && (
          <button type="button" className="btn-remove-text" onClick={remove} disabled={busy}>
            Remove key
          </button>
        )}
      </div>
    </div>
  );
}

export default function ModelKeysSettings({ initial }: { initial: ModelKeyView[] }) {
  return (
    <div className="settings-section">
      <h2>AI Model</h2>
      <p className="billing-muted">
        Provision the provider API keys your scenarios use for live voice and chat. Keys are validated with the
        provider when you save, stored for your account, and used server-side only — they never reach the browser.
      </p>

      <div className="settings-memory-groups">
        {initial.map((k) => (
          <ProviderCard key={k.provider} initial={k} />
        ))}
      </div>
    </div>
  );
}
