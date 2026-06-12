/**
 * Documentation home (SAU-251 — Resources › Documentation).
 *
 * The landing page for our product docs: a short intro plus a card grid of every
 * section and its articles, wrapped in the shared DocsShell sidebar. Server
 * component — docs are static first-party content (see services/docs.ts), so
 * there's no DB read here.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { DOC_SECTIONS, toSidebarSections } from '@/services/docs';
import DocsShell from '@/components/DocsShell';

export const metadata: Metadata = {
  title: 'Documentation — Agent Platform',
  description: 'Guides for practising, building, and managing scenarios, courses, and coaches.',
};

export default function DocsHomePage() {
  const sections = toSidebarSections(DOC_SECTIONS);

  return (
    <DocsShell sections={sections} activeSlug={null}>
      <header className="docs-hero">
        <h1>Documentation</h1>
        <p className="subtitle">
          Everything you need to practise high-stakes conversations, build your own
          roleplay partners, and manage your account.
        </p>
      </header>

      {DOC_SECTIONS.map((s) => (
        <section className="docs-home-section" key={s.id} id={s.id}>
          <h2>{s.title}</h2>
          <div className="grid">
            {s.articles.map((a) => (
              <Link key={a.slug} href={`/docs/${a.slug}`} className="card">
                <h3>{a.title}</h3>
                <p>{a.summary}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </DocsShell>
  );
}
