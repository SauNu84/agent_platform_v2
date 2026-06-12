/**
 * SettingsShell (SAU-253) — the Settings hub chrome: a page header plus a left
 * sub-nav that switches the right-hand panel. Each sub-nav entry is a real route
 * (/settings/<tab>) so links are bookmarkable and there are no dead targets
 * (design rule, SAU-216). Server component — the interactive bits live in the
 * per-tab client islands rendered as {children}.
 */
import Link from 'next/link';

export interface SettingsTab {
  id: string;
  label: string;
  icon: string;
}

// Order mirrors the board's reference (Account → Language → Memory → Knowledge
// Bases → My Voice → Integrations).
export const SETTINGS_TABS: SettingsTab[] = [
  { id: 'account', label: 'Account', icon: '👤' },
  { id: 'language', label: 'Language', icon: '🌐' },
  { id: 'memory', label: 'Memory', icon: '🧠' },
  { id: 'knowledge-bases', label: 'Knowledge Bases', icon: '📚' },
  { id: 'my-voice', label: 'My Voice', icon: '🎙' },
  { id: 'integrations', label: 'Integrations', icon: '🔌' },
];

export function isSettingsTab(id: string): boolean {
  return SETTINGS_TABS.some((t) => t.id === id);
}

export default function SettingsShell({
  active,
  children,
}: {
  active: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings">
      <header className="settings-head">
        <h1>Settings</h1>
        <p className="subtitle">Manage your profile, preferences, and account configuration.</p>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <ul>
            {SETTINGS_TABS.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/settings/${t.id}`}
                  className={t.id === active ? 'is-active' : undefined}
                  aria-current={t.id === active ? 'page' : undefined}
                >
                  <span className="settings-nav-ico" aria-hidden="true">{t.icon}</span>
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <section className="settings-panel">{children}</section>
      </div>
    </div>
  );
}
