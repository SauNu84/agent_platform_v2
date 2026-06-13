/**
 * Use Case catalog hub (SAU-269 — top-level "Use Case" group).
 *
 * Landing page for the use-case catalog: a short intro plus a card per use case,
 * wrapped in the shared UseCaseShell sidebar. Server component — use cases are
 * static first-party content (services/use-cases.ts), so there's no DB read here.
 * Built to grow: each registry entry becomes a card automatically.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getAllUseCases, toUseCaseLinks } from '@/services/use-cases';
import UseCaseShell from '@/components/UseCaseShell';

export const metadata: Metadata = {
  title: 'Use Cases — Agent Platform',
  description: 'Real things this platform can do — action-taking agents, explained for first-time readers.',
};

export default function UseCasesHomePage() {
  const useCases = getAllUseCases();

  return (
    <UseCaseShell links={toUseCaseLinks()} activeSlug={null}>
      <header className="docs-hero">
        <h1>Use Cases</h1>
        <p className="subtitle">
          Beyond practice scenarios, the platform can run real <strong>action-taking
          agents</strong> that do the work — answer a call, collect information, and
          complete a task. Each use case below explains the situation, how the
          conversation flows, and what you get at the end.
        </p>
      </header>

      <section className="docs-home-section">
        <h2>Catalog</h2>
        <div className="grid">
          {useCases.map((u) => (
            <Link key={u.slug} href={`/use-cases/${u.slug}`} className="card">
              <h3>
                <span aria-hidden="true">{u.icon}</span> {u.title}
              </h3>
              <p>{u.summary}</p>
            </Link>
          ))}
        </div>
      </section>
    </UseCaseShell>
  );
}
