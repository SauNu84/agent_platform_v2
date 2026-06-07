import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Platform — Scenarios',
  description: 'Hyper-realistic AI roleplay to practice high-stakes conversations.',
};

// Fixed left nav from the verified reference UI (design §intro). Only Scenarios is
// live in Slice 1; later slices fill in Course / Coach / Analytics / History.
const NAV = [
  { href: '/library', label: 'Scenarios', live: true },
  { href: '/course', label: 'Course', live: false },
  { href: '/coach', label: 'Coach', live: false },
  { href: '/analytics', label: 'Analytics', live: false },
  { href: '/history', label: 'History', live: false },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
            <div className="balance">Balance · —</div>
          </nav>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
