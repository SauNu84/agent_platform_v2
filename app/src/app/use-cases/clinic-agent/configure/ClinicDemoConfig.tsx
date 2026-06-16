'use client';

/**
 * ClinicDemoConfig (SAU-297) — the no-code "Set up a demo" panel for the AI Clinic
 * Agent. Two cards:
 *   1. Google Calendar — reuse the SAU-271 per-clinic OAuth flow (connect / pick the
 *      target calendar / disconnect). Once connected, the booking tools write events
 *      into THIS calendar (resolveCalendarAdapter, per-clinic, RLS-isolated).
 *   2. Phone numbers — the agent number patients call (defaults to the live trial
 *      number) + an optional clinic handoff number, persisted per-clinic.
 *
 * All secrets stay server-side: the OAuth tokens never reach the browser (only the
 * masked connection view), and phone numbers aren't credentials.
 */
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

const RETURN_TO = '/use-cases/clinic-agent/configure';

interface CalendarOAuthView {
  connected: boolean;
  calendarId: string | null;
  scope: string | null;
  connectedAt: string | null;
  oauthConfigured: boolean;
}

interface ClinicPhoneView {
  agentNumber: string | null;
  clinicHandoffNumber: string | null;
  defaultAgentNumber: string;
  configured: boolean;
  envAgentNumber: string | null;
  updatedAt: string | null;
}

/** Map the ?calendar= flag the OAuth callback adds to a status banner. */
const CALENDAR_STATUS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google Calendar connected. The agent now books appointments into this calendar.' },
  denied: { ok: false, text: 'Google sign-in was cancelled — no calendar was connected.' },
  invalid: { ok: false, text: 'The connection response was incomplete. Please try connecting again.' },
  state_mismatch: { ok: false, text: 'Security check failed (state mismatch). Please try connecting again.' },
  not_configured: { ok: false, text: 'Google Calendar OAuth is not configured on this server.' },
  error: { ok: false, text: 'Could not complete the connection with Google. Please try again.' },
};

function CalendarCard({ initial }: { initial: CalendarOAuthView }) {
  const params = useSearchParams();
  const flag = params.get('calendar');
  const banner = flag ? CALENDAR_STATUS[flag] : null;

  const [view, setView] = useState(initial);
  const [calendarId, setCalendarId] = useState(initial.calendarId ?? 'primary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const connectHref = `/api/integrations/google-calendar/connect?returnTo=${encodeURIComponent(
    RETURN_TO,
  )}&calendarId=${encodeURIComponent(calendarId.trim() || 'primary')}`;

  async function disconnect() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/integrations/google-calendar/disconnect', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not disconnect.');
      setView(json.connection);
      setCalendarId(json.connection?.calendarId ?? 'primary');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveCalendar() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/integrations/google-calendar/calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId: calendarId.trim() || 'primary' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not update the target calendar.');
      setView(json.connection);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-integration">
      <div className="settings-integration-head">
        <div>
          <h3>1. Connect Google Calendar</h3>
          <p className="billing-muted">
            Link the clinic&apos;s Google Calendar. The agent reads free/busy from it and writes each booked
            appointment into it — per clinic, isolated from every other account.
          </p>
        </div>
        <span className={`settings-badge ${view.connected ? 'connected' : ''}`}>
          {view.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {banner && (
        <p className={banner.ok ? 'settings-pending-note' : 'billing-error'} role={banner.ok ? undefined : 'alert'}>
          {banner.text}
        </p>
      )}

      {!view.oauthConfigured && (
        <p className="billing-muted">
          Live Google Calendar OAuth isn&apos;t configured on this server
          (<code>GOOGLE_OAUTH_CLIENT_ID</code> / <code>GOOGLE_OAUTH_CLIENT_SECRET</code>), so bookings use the
          simulated sandbox calendar. Once those are set, connect a real calendar here — no code changes.
        </p>
      )}

      <div className="settings-field">
        <label htmlFor="cal-target">Target calendar</label>
        <input
          id="cal-target"
          type="text"
          className="settings-input"
          placeholder="primary"
          value={calendarId}
          onChange={(e) => {
            setCalendarId(e.target.value);
            setSaved(false);
          }}
          disabled={busy}
        />
        <p className="billing-muted">
          Use <code>primary</code> for the account&apos;s main calendar, or paste a specific calendar id
          (its address, e.g. <code>clinic@group.calendar.google.com</code>).
        </p>
      </div>

      {view.connected ? (
        <>
          <p className="settings-pending-note">
            Connected — booking into <code>{view.calendarId ?? 'primary'}</code>.
            {view.connectedAt ? ` Connected ${new Date(view.connectedAt).toLocaleString()}.` : ''}
          </p>
          {saved && <p className="settings-pending-note">Target calendar updated.</p>}
          <div className="settings-actions">
            <button type="button" className="btn" onClick={saveCalendar} disabled={busy}>
              {busy ? 'Saving…' : 'Use this calendar'}
            </button>
            <button type="button" className="btn-remove-text" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <div className="settings-actions">
          <a
            className="btn"
            href={connectHref}
            aria-disabled={!view.oauthConfigured}
            onClick={(e) => {
              if (!view.oauthConfigured) e.preventDefault();
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

function PhoneCard({ initial }: { initial: ClinicPhoneView }) {
  const [view, setView] = useState(initial);
  const [agentNumber, setAgentNumber] = useState(initial.agentNumber ?? initial.defaultAgentNumber);
  const [handoff, setHandoff] = useState(initial.clinicHandoffNumber ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/use-cases/clinic-agent/phone', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentNumber, clinicHandoffNumber: handoff }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save the phone numbers.');
      setView(json.phone);
      setAgentNumber(json.phone.agentNumber ?? json.phone.defaultAgentNumber);
      setHandoff(json.phone.clinicHandoffNumber ?? '');
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/use-cases/clinic-agent/phone', { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not reset the phone numbers.');
      setView(json.phone);
      setAgentNumber(json.phone.agentNumber ?? json.phone.defaultAgentNumber);
      setHandoff(json.phone.clinicHandoffNumber ?? '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-integration">
      <div className="settings-integration-head">
        <div>
          <h3>2. Set the phone numbers</h3>
          <p className="billing-muted">
            The <strong>agent number</strong> is what patients call to reach the AI receptionist. Add an optional
            <strong> clinic handoff number</strong> the agent warm-transfers to when a human is needed.
          </p>
        </div>
        <span className={`settings-badge ${view.configured ? 'connected' : ''}`}>
          {view.configured ? 'Configured' : 'Using default'}
        </span>
      </div>

      <div className="settings-field">
        <label htmlFor="agent-number">Agent number (patients call this)</label>
        <input
          id="agent-number"
          type="text"
          className="settings-input"
          placeholder={view.defaultAgentNumber}
          value={agentNumber}
          onChange={(e) => {
            setAgentNumber(e.target.value);
            setSaved(false);
          }}
          disabled={busy}
        />
        <p className="billing-muted">
          Defaults to the live trial number <code>{view.defaultAgentNumber}</code>. E.164 format (leading +).
        </p>
      </div>

      <div className="settings-field">
        <label htmlFor="handoff-number">Clinic handoff number (optional)</label>
        <input
          id="handoff-number"
          type="text"
          className="settings-input"
          placeholder="+1…"
          value={handoff}
          onChange={(e) => {
            setHandoff(e.target.value);
            setSaved(false);
          }}
          disabled={busy}
        />
      </div>

      {view.envAgentNumber && (
        <p className="billing-muted">
          A server-configured number (<code>{view.envAgentNumber}</code>) is set in the environment and takes
          precedence on the live bridge.
        </p>
      )}
      {saved && <p className="settings-pending-note">Phone numbers saved.</p>}
      {error && <p className="billing-error" role="alert">{error}</p>}

      <div className="settings-actions">
        <button type="button" className="btn" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save numbers'}
        </button>
        {view.configured && (
          <button type="button" className="btn-remove-text" onClick={reset} disabled={busy}>
            Reset to default
          </button>
        )}
      </div>
    </div>
  );
}

export default function ClinicDemoConfig({
  calendarOAuth,
  phone,
}: {
  calendarOAuth: CalendarOAuthView;
  phone: ClinicPhoneView;
}) {
  const ready = calendarOAuth.connected;
  return (
    <div className="settings-section">
      <h2>Set up a demo</h2>
      <p className="billing-muted">
        Connect a clinic&apos;s Google Calendar and set the phone numbers, then run a call: the agent collects
        intake, checks availability against this calendar, and books the appointment <strong>in it</strong>. No
        code or environment edits.
      </p>

      <div className="settings-integration-list">
        <CalendarCard initial={calendarOAuth} />
        <PhoneCard initial={phone} />

        <div className="settings-integration">
          <h3>3. Run the demo</h3>
          <p className="billing-muted">
            {ready
              ? 'Calendar connected — talk to the agent and watch the event appear in your calendar.'
              : 'Connect a calendar above first; then run a call.'}
          </p>
          <ul className="billing-muted">
            <li>
              Open the live agent at <code>/scenarios/clinic-intake-booking</code> (browser voice), or run a
              synthetic caller over the real bridge.
            </li>
            <li>
              Complete an intake and confirm a slot — <code>create_appointment</code> writes the event into the
              connected calendar and returns its event id.
            </li>
            <li>Open Google Calendar and confirm the appointment landed in the target calendar.</li>
          </ul>
          <p className="billing-muted">
            Synthetic / internal-test only for now. Real patient data waits on a signed clinic and the HIPAA
            program.
          </p>
        </div>
      </div>
    </div>
  );
}
