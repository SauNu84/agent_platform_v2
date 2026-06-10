import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { getStore } from '@/db';
import { getMeterState } from '@/services/meter';
import { currentUserId } from '@/services/current-user';
import TopBar from '@/components/TopBar';

// Demo identity for the user menu (pre-auth — see current-user.ts). Replaced
// when the real identity/auth model lands.
const DEMO_USER = { name: 'Demo User', email: 'demo@agentplatform.local', streakDays: 1 };

// Applied before first paint to avoid a light→dark flash on reload (SAU-228).
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.dataset.theme=d?'dark':'light';e.dataset.themePref=t;}catch(e){}})();`;

export const metadata: Metadata = {
  title: 'Agent Platform — Scenarios',
  description: 'Hyper-realistic AI roleplay to practice high-stakes conversations.',
};

// Fixed left nav from the verified reference UI (design §intro). All sections
// are live as of the Slice 1-4 integration (SAU-210): Scenarios (S1),
// Courses + Coaches (S3), Analytics + History (S2).
const NAV = [
  { href: '/library', label: 'Scenarios', live: true },
  { href: '/courses', label: 'Course', live: true },
  { href: '/coaches', label: 'Coach', live: true },
  { href: '/analytics', label: 'Analytics', live: true },
  { href: '/history', label: 'History', live: true },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Live credit balance for the current user (Slice 2 meter). Fail-soft: a store
  // hiccup must never break the chrome.
  let balance = '—';
  try {
    const meter = await getMeterState(getStore(), currentUserId());
    balance = `${meter.remainingMinutes.toFixed(1)} min left`;
  } catch {
    /* keep placeholder */
  }
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <div className="app-shell">
          <nav className="side-nav">
            <div className="brand">Agent Platform</div>
            <ul>
              {NAV.map((n) => (
                <li key={n.href}>
                  {n.live ? (
                    <Link href={n.href}>{n.label}</Link>
                  ) : (
                    <span className="nav-disabled" title="Coming in a later slice">{n.label}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="balance">Balance · {balance}</div>
          </nav>
          <main className="content">
            <TopBar
              userName={DEMO_USER.name}
              userEmail={DEMO_USER.email}
              streakDays={DEMO_USER.streakDays}
            />
            <div className="content-body">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
