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
  /** When true, the tab is only shown/accessible to admins (board, SAU-259). */
  adminOnly?: boolean;
}

// Order mirrors the board's reference (Account → Language → Memory → Knowledge
// Bases → My Voice → Integrations).
export const SETTINGS_TABS: SettingsTab[] = [
  { id: 'account', label: 'Account', icon: '👤' },
  { id: 'language', label: 'Language', icon: '🌐' },
  { id: 'memory', label: 'Memory', icon: '🧠' },
  { id: 'knowledge-bases', label: 'Knowledge Bases', icon: '📚' },
  { id: 'my-voice', label: 'My Voice', icon: '🎙' },
  { id: 'ai-model', label: 'AI Model', icon: '🤖', adminOnly: true },
  { id: 'integrations', label: 'Integrations', icon: '🔌' },
];

/** Tabs visible to the given viewer (admin-only tabs are hidden for non-admins). */
export function visibleSettingsTabs(isAdmin: boolean): SettingsTab[] {
  return SETTINGS_TABS.filter((t) => !t.adminOnly || isAdmin);
}

/** A known tab id. Pass `isAdmin` to also enforce admin-only access. */
export function isSettingsTab(id: string, isAdmin = true): boolean {
  return visibleSettingsTabs(isAdmin).some((t) => t.id === id);
}

export default function SettingsShell({
  active,
  isAdmin = false,
  children,
}: {
  active: string;
  isAdmin?: boolean;
  children: React.ReactNode;
}) {
  const tabs = visibleSettingsTabs(isAdmin);
  return (
    <div className="settings">
      <header className="settings-head">
        <h1>Settings</h1>
        <p className="subtitle">Manage your profile, preferences, and account configuration.</p>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <ul>
            {tabs.map((t) => (
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
