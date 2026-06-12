'use client';

/**
 * Integrations tab client island (SAU-253) — connect external services: a phone
 * SIP trunk, a calendar connection, and MCP tools (Gmail, Google Calendar).
 * Each card persists its connection config (PUT /api/settings/integrations/<id>)
 * and can be disconnected (DELETE). Live execution of each integration is a
 * follow-up; a connected card shows "Connected" with the saved config.
 */
import { useState } from 'react';

interface FieldSpec {
  name: string;
  label: string;
  placeholder: string;
  options?: { value: string; label: string }[];
  multi?: boolean;
}

interface IntegrationView {
  id: string;
  title: string;
  description: string;
  fields: FieldSpec[];
  status: 'not_connected' | 'configured';
  config: Record<string, unknown>;
  updatedAt: string | null;
}

function initialForm(iv: IntegrationView): Record<string, string | string[]> {
  const form: Record<string, string | string[]> = {};
  for (const f of iv.fields) {
    const v = iv.config[f.name];
    if (f.multi) form[f.name] = Array.isArray(v) ? (v as string[]) : v != null ? [String(v)] : [];
    else form[f.name] = v != null ? String(v) : f.options?.[0]?.value ?? '';
  }
  return form;
}

function IntegrationCard({ initial }: { initial: IntegrationView }) {
  const [iv, setIv] = useState<IntegrationView>(initial);
  const [form, setForm] = useState<Record<string, string | string[]>>(initialForm(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setField(name: string, value: string | string[]) {
    setForm((f) => ({ ...f, [name]: value }));
  }

  function toggleMulti(name: string, value: string) {
    setForm((f) => {
      const cur = Array.isArray(f[name]) ? (f[name] as string[]) : [];
      return { ...f, [name]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/integrations/${iv.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: form }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save integration.');
      setIv(json.integration);
      setForm(initialForm(json.integration));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/integrations/${iv.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not disconnect.');
      setIv(json.integration);
      setForm(initialForm(json.integration));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const connected = iv.status === 'configured';

  return (
    <div className="settings-integration">
      <div className="settings-integration-head">
        <div>
          <h3>{iv.title}</h3>
          <p className="billing-muted">{iv.description}</p>
        </div>
        <span className={`settings-badge ${connected ? 'connected' : ''}`}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      <div className="settings-integration-form">
        {iv.fields.map((f) => (
          <div className="settings-field" key={f.name}>
            <label htmlFor={`${iv.id}-${f.name}`}>{f.label}</label>
            {!f.options && (
              <input
                id={`${iv.id}-${f.name}`}
                type="text"
                className="settings-input"
                placeholder={f.placeholder}
                value={(form[f.name] as string) ?? ''}
                onChange={(e) => setField(f.name, e.target.value)}
                disabled={busy}
              />
            )}
            {f.options && f.multi && (
              <div className="settings-options">
                {f.options.map((o) => (
                  <label key={o.value} className="settings-check">
                    <input
                      type="checkbox"
                      checked={(form[f.name] as string[])?.includes(o.value) ?? false}
                      onChange={() => toggleMulti(f.name, o.value)}
                      disabled={busy}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
            {f.options && !f.multi && (
              <select
                id={`${iv.id}-${f.name}`}
                className="settings-select"
                value={(form[f.name] as string) ?? ''}
                onChange={(e) => setField(f.name, e.target.value)}
                disabled={busy}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>

      {connected && (
        <p className="settings-pending-note">
          Connection saved. Live activation of this integration is rolling out — your configuration is stored and
          will take effect once enabled for your account.
        </p>
      )}

      {error && <p className="billing-error" role="alert">{error}</p>}

      <div className="settings-actions">
        <button type="button" className="btn" onClick={connect} disabled={busy}>
          {busy ? 'Saving…' : connected ? 'Update connection' : 'Connect'}
        </button>
        {connected && (
          <button type="button" className="btn-remove-text" onClick={disconnect} disabled={busy}>
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

export default function IntegrationsSettings({ integrations }: { integrations: IntegrationView[] }) {
  return (
    <div className="settings-section">
      <h2>Integrations</h2>
      <p className="billing-muted">Connect your accounts and configure external services.</p>
      <div className="settings-integration-list">
        {integrations.map((iv) => (
          <IntegrationCard key={iv.id} initial={iv} />
        ))}
      </div>
    </div>
  );
}
