/**
 * Scenario detail page — server component. Fetches the canonical scenario + its
 * sessions and renders the shared DetailShell (reused later by Coach/Course).
 */
import { notFound } from 'next/navigation';
import { getStore } from '@/db';
import DetailShell, { type SessionSummary } from '@/components/DetailShell';

export const dynamic = 'force-dynamic';

export default async function ScenarioDetailPage({ params }: { params: { slug: string } }) {
  const store = getStore();
  const scenario = await store.getScenarioBySlug(params.slug);
  if (!scenario) notFound();

  const sessions = await store.listSessionsByScenario(scenario.id);
  const initialSessions: SessionSummary[] = sessions.map((s) => ({
    id: s.id,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    turns: s.transcript?.turns ?? [],
  }));

  return (
    <DetailShell
      kind="Scenario"
      slug={scenario.slug}
      name={scenario.name}
      overview={scenario.description}
      instructions={scenario.aiInstructions}
      rubric={scenario.rubric}
      metadata={scenario.metadata}
      voice={{ name: scenario.voiceName, languageCode: scenario.languageCode }}
      initialSessions={initialSessions}
      sessionsEndpoint={`/api/scenarios/${scenario.slug}/sessions`}
    />
  );
}
