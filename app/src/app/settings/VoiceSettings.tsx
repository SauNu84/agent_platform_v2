'use client';

/**
 * My Voice tab client island (SAU-253) — create/update a voice profile to clone
 * your voice for use with Cartesia TTS in voice scenarios. Saving persists the
 * profile (PUT /api/settings/voice); live synthesis activation is a follow-up,
 * so a saved profile shows a "Pending activation" status (honest, not a dead
 * button — the config is really stored).
 */
import { useState } from 'react';

interface VoiceProfileView {
  name: string | null;
  status: 'none' | 'pending';
  updatedAt: string | null;
}

interface GeminiLiveKeyView {
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
}

export default function VoiceSettings({
  initial,
  geminiKey,
  envKeyPresent,
}: {
  initial: VoiceProfileView;
  geminiKey: GeminiLiveKeyView;
  envKeyPresent: boolean;
}) {
  const [profile, setProfile] = useState<VoiceProfileView>(initial);
  const [name, setName] = useState(initial.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save voice profile.');
      setProfile(json.profile);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/voice', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not remove voice profile.');
      setProfile({ name: null, status: 'none', updatedAt: null });
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── Live-voice (Gemini) API key (SAU-259) ──────────────────────────────────
  const [keyView, setKeyView] = useState<GeminiLiveKeyView>(geminiKey);
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  async function saveKey() {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await fetch('/api/settings/gemini-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyInput }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save the key.');
      setKeyView(json.key);
      setKeyInput('');
    } catch (e) {
      setKeyError((e as Error).message);
    } finally {
      setKeyBusy(false);
    }
  }

  async function removeKey() {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await fetch('/api/settings/gemini-key', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not remove the key.');
      setKeyView({ configured: false, last4: null, updatedAt: null });
    } catch (e) {
      setKeyError((e as Error).message);
    } finally {
      setKeyBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h2>My Voice</h2>
      <p className="billing-muted">
        Clone your voice for use with Cartesia TTS in voice scenarios. Name your profile to get started.
      </p>

      {profile.status === 'pending' && (
        <div className="settings-status-card">
          <div>
            <strong>{profile.name}</strong>
            <span className="settings-badge pending">Pending activation</span>
          </div>
          <p className="billing-muted">
            Your voice profile is saved. Voice synthesis turns on once Cartesia voice cloning is connected for
            your account.
          </p>
        </div>
      )}

      <div className="settings-field">
        <label htmlFor="voice-name">Voice profile name</label>
        <input
          id="voice-name"
          type="text"
          className="settings-input"
          placeholder="e.g. My speaking voice"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>

      {error && <p className="billing-error" role="alert">{error}</p>}

      <div className="settings-actions">
        <button type="button" className="btn" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : profile.status === 'pending' ? 'Update profile' : 'Create voice profile'}
        </button>
        {profile.status === 'pending' && (
          <button type="button" className="btn-remove-text" onClick={remove} disabled={busy}>
            Remove
          </button>
        )}
      </div>

      {/* Live voice engine key (SAU-259) — self-provision the Gemini Live key so a
          paid user picking "Gemini" runs a real live browser session (not mock). */}
      <h3 className="settings-subhead">Live voice engine key (Gemini)</h3>
      <p className="billing-muted">
        Paste a Google Gemini API key with billing enabled to run live voice on Gemini 2.5 Flash Live. The key is
        stored for your account and used server-side only — it never reaches the browser. Without a key, live Gemini
        sessions fall back to the simulated demo.
      </p>

      {envKeyPresent && (
        <div className="settings-status-card">
          <div>
            <strong>Provisioned via environment</strong>
            <span className="settings-badge">Active</span>
          </div>
          <p className="billing-muted">
            A Gemini key is set in the server environment (app/.env.local), which takes precedence. A key saved here
            is kept as a fallback but isn&apos;t used while the environment key is present.
          </p>
        </div>
      )}

      {keyView.configured && (
        <div className="settings-status-card">
          <div>
            <strong>Key saved · ending …{keyView.last4}</strong>
            <span className="settings-badge pending">Stored</span>
          </div>
          <p className="billing-muted">
            Live Gemini voice is provisioned for your account. Pick Gemini in a voice scenario to run it live.
          </p>
        </div>
      )}

      <div className="settings-field">
        <label htmlFor="gemini-key">{keyView.configured ? 'Replace Gemini API key' : 'Gemini API key'}</label>
        <input
          id="gemini-key"
          type="password"
          autoComplete="off"
          className="settings-input"
          placeholder="AIza…"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          disabled={keyBusy}
        />
      </div>

      {keyError && <p className="billing-error" role="alert">{keyError}</p>}

      <div className="settings-actions">
        <button type="button" className="btn" onClick={saveKey} disabled={keyBusy || !keyInput.trim()}>
          {keyBusy ? 'Saving…' : keyView.configured ? 'Update key' : 'Save key'}
        </button>
        {keyView.configured && (
          <button type="button" className="btn-remove-text" onClick={removeKey} disabled={keyBusy}>
            Remove key
          </button>
        )}
      </div>
    </div>
  );
}
