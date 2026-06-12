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

export default function VoiceSettings({ initial }: { initial: VoiceProfileView }) {
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
    </div>
  );
}
