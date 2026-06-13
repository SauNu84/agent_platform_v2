'use client';

/**
 * Integrations tab client island (SAU-253) — connect external services: a phone
 * SIP trunk, a calendar connection, and MCP tools (Gmail, Google Calendar).
 * Each card persists its connection config (PUT /api/settings/integrations/<id>)
 * and can be disconnected (DELETE). Live execution of each integration is a
 * follow-up; a connected card shows "Connected" with the saved config.
 */
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

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

interface CalendarOAuthView {
  connected: boolean;
  calendarId: string | null;
  scope: string | null;
  connectedAt: string | null;
  oauthConfigured: boolean;
}

/** Map the ?calendar= status flag returned by the OAuth callback to a message. */
const CALENDAR_STATUS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google Calendar connected. Bookings now read and write your real calendar.' },
  denied: { ok: false, text: 'Google sign-in was cancelled — no calendar was connected.' },
  invalid: { ok: false, text: 'The connection response was incomplete. Please try connecting again.' },
  state_mismatch: { ok: false, text: 'Security check failed (state mismatch). Please try connecting again.' },
  not_configured: { ok: false, text: 'Google Calendar OAuth is not configured on this server.' },
  error: { ok: false, text: 'Could not complete the connection with Google. Please try again.' },
};

/**
 * Real Google Calendar OAuth (SAU-271, Phase 1 · WS2). When the calendar provider
 * is Google, the clinic connects its real calendar here; bookings then read real
 * free/busy and write real events. No credentials configured ⇒ booking stays on
 * the simulated sandbox calendar (the button explains this).
 */
function GoogleCalendarConnect({ oauth, providerIsGoogle }: { oauth: CalendarOAuthView; providerIsGoogle: boolean }) {
  const params = useSearchParams();
  const flag = params.get('calendar');
  const banner = flag ? CALENDAR_STATUS[flag] : null;
  const [connected, setConnected] = useState(oauth.connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/google-calendar/disconnect', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not disconnect.');
      setConnected(Boolean(json.connection?.connected));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!providerIsGoogle) return null;

  return (
    <div className="settings-oauth-block">
      {banner && (
        <p className={banner.ok ? 'settings-pending-note' : 'billing-error'} role={banner.ok ? undefined : 'alert'}>
          {banner.text}
        </p>
      )}
      {!oauth.oauthConfigured && (
        <p className="billing-muted">
          Live Google Calendar OAuth isn&apos;t configured on this server yet, so bookings use the simulated sandbox
          calendar. Once the connection is enabled, you&apos;ll be able to link your real calendar here.
        </p>
      )}
      {connected ? (
        <>
          <p className="settings-pending-note">
            Real Google Calendar connected{oauth.calendarId ? ` (${oauth.calendarId})` : ''}. <code>check_availability</code>{' '}
            reads real free/busy and <code>create_appointment</code> writes real events.
          </p>
          <div className="settings-actions">
            <button type="button" className="btn-remove-text" onClick={disconnect} disabled={busy}>
              {busy ? 'Disconnecting…' : 'Disconnect Google Calendar'}
            </button>
          </div>
        </>
      ) : (
        <div className="settings-actions">
          <a
            className="btn"
            href="/api/integrations/google-calendar/connect"
            aria-disabled={!oauth.oauthConfigured}
            onClick={(e) => {
              if (!oauth.oauthConfigured) e.preventDefault();
            }}
          >
            Connect Google Calendar
          </a>
        </div>
      )}
      {error && <p className="billing-error" role="alert">{error}</p>}
    </div>
  );
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

function IntegrationCard({ initial, calendarOAuth }: { initial: IntegrationView; calendarOAuth?: CalendarOAuthView }) {
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

      {/* Real Google Calendar OAuth (SAU-271 WS2) lives on the calendar card. */}
      {iv.id === 'calendar' && calendarOAuth && (
        <GoogleCalendarConnect oauth={calendarOAuth} providerIsGoogle={(form.provider as string) === 'google'} />
      )}

      {connected && iv.id !== 'calendar' && (
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

export default function IntegrationsSettings({
  integrations,
  calendarOAuth,
}: {
  integrations: IntegrationView[];
  calendarOAuth?: CalendarOAuthView;
}) {
  return (
    <div className="settings-section">
      <h2>Integrations</h2>
      <p className="billing-muted">Connect your accounts and configure external services.</p>
      <div className="settings-integration-list">
        {integrations.map((iv) => (
          <IntegrationCard key={iv.id} initial={iv} calendarOAuth={iv.id === 'calendar' ? calendarOAuth : undefined} />
        ))}
      </div>
    </div>
  );
}
