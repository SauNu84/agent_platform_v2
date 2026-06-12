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

// Left nav, reordered + grouped to mirror the reference rail (SAU-250 board ask):
// a primary "Practice" block, then a labelled "Sessions" group, then an admin
// group, with billing/account pinned to the footer. Each item carries a small
// glyph for parity with the reference. `adminOnly` groups render only for admins
// (platform_admin capability, Slice 5/SAU-229). We list only real destinations —
// no placeholder/dead links (design rule, SAU-216).
const NAV_GROUPS: {
  heading: string | null;
  adminOnly?: boolean;
  items: { href: string; label: string; icon: string }[];
}[] = [
  {
    heading: null,
    items: [
      { href: '/library', label: 'Scenarios', icon: '🎯' },
      { href: '/courses', label: 'Course', icon: '📚' },
      { href: '/coaches', label: 'Coach', icon: '🧭' },
    ],
  },
  {
    heading: 'Sessions',
    items: [
      { href: '/analytics', label: 'Analytics', icon: '📊' },
      { href: '/history', label: 'History', icon: '🕘' },
    ],
  },
  {
    // Resources — first-party help content. Documentation (SAU-251) sits beside
    // Developer Tools (SAU-252), which the board asked to live under Documentation
    // rather than in the Billing footer.
    heading: 'Resources',
    items: [
      { href: '/docs', label: 'Documentation', icon: '📖' },
      { href: '/developer-tools', label: 'Developer Tools', icon: '🧰' },
    ],
  },
  {
    heading: 'Admin',
    adminOnly: true,
    items: [{ href: '/admin', label: 'Admin', icon: '🛡' }],
  },
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
  const groups = NAV_GROUPS.filter((g) => !g.adminOnly || actor?.isAdmin);
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <div className="app-shell">
          <nav className="side-nav">
            <div className="brand">Agent Platform</div>
            <div className="side-nav-scroll">
              {groups.map((g, i) => (
                <div className="side-nav-group" key={g.heading ?? `g${i}`}>
                  {g.heading && <div className="side-nav-heading">{g.heading}</div>}
                  <ul>
                    {g.items.map((n) => (
                      <li key={n.href}>
                        <Link href={n.href}>
                          <span className="side-nav-ico" aria-hidden="true">{n.icon}</span>
                          {n.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {/* Pinned account footer — Balance + Upgrade + Billing, mirrors the
                reference left rail (SAU-250). */}
            <div className="side-foot">
              <Link href="/billing" className="side-balance">
                <span className="side-balance-label">Balance</span>
                <span className="side-balance-val">{balance}</span>
              </Link>
              <Link href="/billing" className="btn side-upgrade">
                <span aria-hidden="true">⚡</span> Upgrade
              </Link>
              <ul className="side-nav-bottom">
                <li>
                  <Link href="/billing">
                    <span className="side-nav-ico" aria-hidden="true">💳</span> Billing
                  </Link>
                </li>
              </ul>
            </div>
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
