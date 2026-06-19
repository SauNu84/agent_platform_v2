/**
 * Use Case explainer page (SAU-269) — /use-cases/[slug].
 *
 * Renders one use case's Markdown body inside the shared UseCaseShell. The body is
 * rendered through MarkdownDoc, so ```mermaid fences (the user-flow flowchart and
 * the behind-the-scenes sequence diagram) render as real diagrams. Static
 * first-party content (services/use-cases.ts), so routes are pre-generated and
 * there's no DB read. Unknown slugs 404 (no dead links — SAU-216).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAllUseCases, getUseCase, toUseCaseLinks } from '@/services/use-cases';
import UseCaseShell from '@/components/UseCaseShell';
import MarkdownDoc from '@/components/MarkdownDoc';

export function generateStaticParams() {
  return getAllUseCases().map((u) => ({ slug: u.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const useCase = getUseCase(params.slug);
  if (!useCase) return { title: 'Use Cases — Proviso' };
  return {
    title: `${useCase.title} — Use Cases`,
    description: useCase.summary,
  };
}

export default function UseCasePage({ params }: { params: { slug: string } }) {
  const useCase = getUseCase(params.slug);
  if (!useCase) notFound();

  return (
    <UseCaseShell links={toUseCaseLinks()} activeSlug={useCase.slug}>
      <nav className="docs-breadcrumb">
        <Link href="/use-cases">Use Cases</Link> <span aria-hidden="true">/</span>{' '}
        {useCase.navLabel}
      </nav>

      {/* SAU-297: the clinic agent's no-code "Set up a demo" panel is reached from
          the left-nav sub-item under "AI Clinic Agent" (UseCaseShell), per board
          preference — no in-page button. */}
      <MarkdownDoc markdown={useCase.body} />
    </UseCaseShell>
  );
}
