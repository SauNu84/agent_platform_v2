import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { getStore } from '@/db';
import { getMeterState } from '@/services/meter';
import { getActor } from '@/services/current-user';
import TopBar from '@/components/TopBar';

// Applied before first paint to avoid a light→dark flash on reload (SAU-228).
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.dataset.theme=d?'dark':'light';e.dataset.themePref=t;}catch(e){}})();`;

export const metadata: Metadata = {
  title: 'Agent Platform — Scenarios',
  description: 'Hyper-realistic AI roleplay to practice high-stakes conversations.',
};

// Fixed left nav from the verified reference UI (design §intro). All sections
// are live as of the Slice 1-4 integration (SAU-210): Scenarios (S1),
// Courses + Coaches (S3), Analytics + History (S2). `adminOnly` items are gated
// on the platform_admin capability (Slice 5, SAU-229).
const NAV = [
  { href: '/library', label: 'Scenarios', adminOnly: false },
  { href: '/courses', label: 'Course', adminOnly: false },
  { href: '/coaches', label: 'Coach', adminOnly: false },
  { href: '/analytics', label: 'Analytics', adminOnly: false },
  { href: '/history', label: 'History', adminOnly: false },
  { href: '/admin', label: 'Admin', adminOnly: true },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolve the authenticated actor (null on the public /login screen). Binds the
  // RLS context for the rest of the request as a side effect.
  const actor = await getActor();

  // Live credit balance for the current user (Slice 2 meter). Fail-soft: a store
  // hiccup (or no actor yet) must never break the chrome.
  let balance = '—';
  if (actor) {
    try {
      const meter = await getMeterState(getStore(), actor.userId);
      balance = `${meter.remainingMinutes.toFixed(1)} min left`;
    } catch {
      /* keep placeholder */
    }
  }
  const nav = NAV.filter((n) => !n.adminOnly || actor?.isAdmin);
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
              {nav.map((n) => (
                <li key={n.href}>
                  <Link href={n.href}>{n.label}</Link>
                </li>
              ))}
            </ul>
            {/* Bottom group — account/billing, mirrors the reference left rail (SAU-250). */}
            <ul className="side-nav-bottom">
              <li>
                <Link href="/billing">Billing</Link>
              </li>
            </ul>
            <Link href="/billing" className="balance">Balance · {balance}</Link>
          </nav>
          <main className="content">
            <TopBar
              userName={actor?.displayName ?? 'Guest'}
              userEmail={actor?.email ?? ''}
              role={actor?.role}
              loggedIn={Boolean(actor)}
            />
            <div className="content-body">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
