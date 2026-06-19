/**
 * Documentation article page (SAU-251) — /docs/[slug].
 *
 * Renders one article's Markdown body inside the shared DocsShell, with prev/next
 * links at the foot. Static first-party content (services/docs.ts), so the routes
 * are pre-generated and there's no DB read. Unknown slugs 404.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getAllArticles,
  getArticle,
  getAdjacent,
  toSidebarSections,
} from '@/services/docs';
import DocsShell, { DocBody } from '@/components/DocsShell';

export function generateStaticParams() {
  return getAllArticles().map((a) => ({ slug: a.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const article = getArticle(params.slug);
  if (!article) return { title: 'Documentation — Proviso' };
  return {
    title: `${article.title} — Documentation`,
    description: article.summary,
  };
}

export default function DocArticlePage({ params }: { params: { slug: string } }) {
  const article = getArticle(params.slug);
  if (!article) notFound();

  const sections = toSidebarSections();
  const { prev, next } = getAdjacent(params.slug);

  return (
    <DocsShell sections={sections} activeSlug={article.slug}>
      <nav className="docs-breadcrumb">
        <Link href="/docs">Documentation</Link> <span aria-hidden="true">/</span> {article.title}
      </nav>

      <DocBody markdown={article.body} />

      <nav className="docs-pager">
        {prev ? (
          <Link href={`/docs/${prev.slug}`} className="docs-pager-link prev">
            <span className="docs-pager-dir">← Previous</span>
            <span className="docs-pager-title">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/docs/${next.slug}`} className="docs-pager-link next">
            <span className="docs-pager-dir">Next →</span>
            <span className="docs-pager-title">{next.title}</span>
          </Link>
        )}
      </nav>
    </DocsShell>
  );
}
