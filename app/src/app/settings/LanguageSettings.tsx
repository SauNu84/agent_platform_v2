'use client';

/**
 * Language tab client island (SAU-253) — pick the preferred language for AI
 * conversation and persist it via PUT /api/settings/language.
 */
import { useState } from 'react';

interface LangOption {
  code: string;
  label: string;
}

export default function LanguageSettings({
  languages,
  current,
}: {
  languages: readonly LangOption[];
  current: string;
}) {
  const [lang, setLang] = useState(current);
  const [saved, setSaved] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save language.');
      setSaved(json.lang);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2>Language</h2>
      <p className="billing-muted">
        The preferred language your AI conversation partners speak and understand. Applies to new sessions.
      </p>

      <div className="settings-field">
        <label htmlFor="lang-select">Conversation language</label>
        <select
          id="lang-select"
          className="settings-select"
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          disabled={saving}
        >
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="billing-error" role="alert">{error}</p>}

      <div className="settings-actions">
        <button type="button" className="btn" onClick={save} disabled={saving || lang === saved}>
          {saving ? 'Saving…' : lang === saved ? 'Saved' : 'Save language'}
        </button>
      </div>
    </div>
  );
}
