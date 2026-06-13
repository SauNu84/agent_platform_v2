'use client';

/**
 * UseCaseShell (SAU-269) — reading shell for the "Use Case" catalog: a left
 * in-page sidebar listing every use case plus a main content column. Mirrors the
 * Documentation DocsShell (and reuses its `docs-*` styling) so the catalog reads
 * like the rest of the product. Both the /use-cases hub and each explainer page
 * render inside this shell, so the in-page nav is identical everywhere.
 *
 * The catalog is built to grow: add an entry to services/use-cases.ts and it shows
 * up here automatically (the links are passed in from the registry).
 */
import Link from 'next/link';
import type { UseCaseLink } from '@/services/use-cases';

export interface UseCaseShellProps {
  links: UseCaseLink[];
  /** Slug of the active use case, or null on the catalog hub. */
  activeSlug: string | null;
  children: React.ReactNode;
}

export default function UseCaseShell({ links, activeSlug, children }: UseCaseShellProps) {
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar" aria-label="Use cases">
        <Link href="/use-cases" className={`docs-side-home ${activeSlug === null ? 'active' : ''}`}>
          🧩 Use Cases
        </Link>
        <div className="docs-side-group">
          <div className="docs-side-heading">Catalog</div>
          <ul>
            {links.map((u) => (
              <li key={u.slug}>
                <Link
                  href={`/use-cases/${u.slug}`}
                  className={u.slug === activeSlug ? 'active' : ''}
                >
                  <span aria-hidden="true">{u.icon}</span> {u.navLabel}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <article className="docs-content">{children}</article>
    </div>
  );
}
