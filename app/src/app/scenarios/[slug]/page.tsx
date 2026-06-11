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

  // SAU-246: surface the linked Knowledge Bases (SAU-243) on the detail page —
  // the settings form lets authors link them, but the reader never saw them.
  const linkedKbs = await store.listScenarioKnowledgeBases(scenario.id);
  const knowledgeBases = linkedKbs.map((kb) => ({
    id: kb.id,
    title: kb.title,
    description: kb.description,
    docCount: kb.docCount,
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
      // SAU-246: reflect the configured visibility + linked Knowledge Bases.
      isPublic={scenario.isPublic}
      knowledgeBases={knowledgeBases}
      initialSessions={initialSessions}
      sessionsEndpoint={`/api/scenarios/${scenario.slug}/sessions`}
      // SAU-224: scenario detail offers a text Chat with the persona instead of
      // the live/simulated voice demo. The sessions endpoint above is still used
      // to load the existing transcript history.
      chatEndpoint={`/api/scenarios/${scenario.slug}/chat`}
      // Board direction (2026-06-10): the scenario detail action bar surfaces
      // "Chat + Remix only" — the Share button is intentionally not surfaced here.
      // The SAU-225 short-link service + /s/{code} route + /share endpoint remain
      // intact (still tested), so re-enabling is a one-line `shareEndpoint` change.
      // SAU-226: Remix → clone this config into a new editable draft I own.
      remixHref={`/scenarios/create?remix=${scenario.slug}`}
    />
  );
}
