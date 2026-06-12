'use client';

/**
 * Documentation reading shell (SAU-251) — a left in-page sidebar listing every
 * section + article, and a main content column. Both the Documentation home and
 * each article page render inside this shell so the navigation is identical
 * everywhere, matching the reference product's docs layout (sidebar nav + content).
 *
 * Content is passed in as serializable props (sections for the rail, Markdown body
 * for the article) so the page wrappers stay server components and only the
 * Markdown renderer is a client island.
 */
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SidebarSection } from '@/services/docs';

export interface DocsShellProps {
  sections: SidebarSection[];
  /** Slug of the active article, or null on the Documentation home. */
  activeSlug: string | null;
  children: React.ReactNode;
}

export default function DocsShell({ sections, activeSlug, children }: DocsShellProps) {
  return (
    <div className="docs-shell">
      <aside className="docs-sidebar" aria-label="Documentation">
        <Link href="/docs" className={`docs-side-home ${activeSlug === null ? 'active' : ''}`}>
          📖 Documentation
        </Link>
        {sections.map((s) => (
          <div className="docs-side-group" key={s.id}>
            <div className="docs-side-heading">{s.title}</div>
            <ul>
              {s.articles.map((a) => (
                <li key={a.slug}>
                  <Link href={`/docs/${a.slug}`} className={a.slug === activeSlug ? 'active' : ''}>
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <article className="docs-content">{children}</article>
    </div>
  );
}

/** Render a Markdown doc body using the shared `.brief` typography (SAU-246). */
export function DocBody({ markdown }: { markdown: string }) {
  return (
    <div className="brief">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
