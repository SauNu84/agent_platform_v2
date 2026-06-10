'use client';

/**
 * Top menu bar (SAU-228) — matches the ToughTongue reference chrome:
 *   left:  Home breadcrumb / navigator
 *   right: Language · Help · user menu (avatar + dropdown)
 *
 * The user menu dropdown carries: identity (name/email), streak, a working
 * light/dark/system theme toggle, a "Main Website" link (wired to a placeholder
 * for now — real URL linked later per the ticket), and Log out.
 *
 * Pre-auth: identity is a demo subject (no user table yet, see current-user.ts),
 * so name/email/streak are display props supplied by the server layout.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

type ThemePref = 'light' | 'dark' | 'system';

function applyTheme(pref: ThemePref) {
  if (typeof document === 'undefined') return;
  const dark =
    pref === 'dark' ||
    (pref === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePref = pref;
}

function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('system');

  useEffect(() => {
    const stored = (document.documentElement.dataset.themePref as ThemePref) || 'system';
    setPref(stored);
  }, []);

  const choose = (next: ThemePref) => {
    setPref(next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* private mode — non-fatal */
    }
    applyTheme(next);
  };

  // Re-evaluate "system" when the OS preference flips.
  useEffect(() => {
    if (pref !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const opts: { key: ThemePref; glyph: string; label: string }[] = [
    { key: 'light', glyph: '☀', label: 'Light' },
    { key: 'dark', glyph: '☾', label: 'Dark' },
    { key: 'system', glyph: '🖵', label: 'System' },
  ];

  return (
    <div className="usermenu-theme">
      <span className="usermenu-theme-label">Theme</span>
      <div className="theme-switch" role="group" aria-label="Theme">
        {opts.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`theme-opt ${pref === o.key ? 'active' : ''}`}
            aria-pressed={pref === o.key}
            title={o.label}
            onClick={() => choose(o.key)}
          >
            {o.glyph}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface TopBarProps {
  userName: string;
  userEmail: string;
  streakDays?: number;
}

export default function TopBar({ userName, userEmail, streakDays = 1 }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = userName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header className="top-bar">
      <Link href="/" className="top-crumb" aria-label="Home">
        <span className="top-crumb-icon" aria-hidden="true">⌂</span>
        <span>Home</span>
      </Link>

      <div className="top-actions">
        <button type="button" className="top-action" aria-label="Language">
          <span aria-hidden="true">🌐</span> EN-US
        </button>
        <Link href="/" className="top-action">
          <span aria-hidden="true">💬</span> Help
        </Link>

        <div className="usermenu" ref={ref}>
          <button
            type="button"
            className="usermenu-trigger"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="User menu"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="usermenu-avatar">{initials || '·'}</span>
            {streakDays > 0 && (
              <span className="usermenu-streak-badge" aria-hidden="true">
                {streakDays}🔥
              </span>
            )}
          </button>

          {open && (
            <div className="usermenu-pop" role="menu">
              <div className="usermenu-id">
                <div className="usermenu-name">{userName}</div>
                <div className="usermenu-email">
                  <span aria-hidden="true">👤</span> {userEmail}
                </div>
                {streakDays > 0 && (
                  <div className="usermenu-streak">
                    🔥 {streakDays} day{streakDays === 1 ? '' : 's'} streak!
                  </div>
                )}
              </div>

              <div className="usermenu-divider" />
              <ThemeToggle />

              <div className="usermenu-divider" />
              {/* Main Website target is linked later (SAU-228). */}
              <a href="#" className="usermenu-link" role="menuitem">
                <span aria-hidden="true">🌐</span> Main Website
              </a>
              <button type="button" className="usermenu-link" role="menuitem">
                <span aria-hidden="true">⎋</span> Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
