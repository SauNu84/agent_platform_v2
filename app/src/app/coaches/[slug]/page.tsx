/**
 * Coach detail — reuses the Slice-1 DetailShell verbatim (kind="Coach"), then adds
 * the two things that make a Coach more than a Scenario: a schedule card and the
 * memory panel (consent gate + memory inspector + DSAR controls; ADR-004).
 */
import { notFound } from 'next/navigation';
import { getStore } from '@/db';
import DetailShell, { type SessionSummary } from '@/components/DetailShell';
import CoachMemoryPanel from '@/components/CoachMemoryPanel';
import { getCoach, resolveCoachScenario } from '@/services/coaches';
import { getCoachConsent, CONSENT_POLICY_TEXT, CONSENT_POLICY_VERSION } from '@/coach/consent';
import { describeSchedule, nextOccurrence } from '@/coach/schedule';
import { DEMO_USER_ID } from '@/coach/demo-user';

export const dynamic = 'force-dynamic';

export default async function CoachDetailPage({ params }: { params: { slug: string } }) {
  const store = getStore();
  const coach = await getCoach(store, params.slug);
  if (!coach) notFound();
  const scenario = await resolveCoachScenario(store, coach);
  if (!scenario) {
    return (
      <div>
        <h1>{coach.name}</h1>
        <p className="notice" role="alert">This coach has no composed scenario (scenario_ref). Fix the source and recompile.</p>
      </div>
    );
  }

  const sessions = await store.listSessionsByCoachUser(coach.id, DEMO_USER_ID);
  const initialSessions: SessionSummary[] = sessions.map((s) => ({
    id: s.id, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, turns: s.transcript?.turns ?? [],
  }));

  const consent = await getCoachConsent(store, DEMO_USER_ID, coach.id);
  const memories = await store.listCoachMemory(coach.id, DEMO_USER_ID);
  const next = nextOccurrence(coach.schedule, Date.now());

  return (
    <div>
      <DetailShell
        kind="Coach"
        slug={coach.slug}
        name={coach.name}
        overview={scenario.description}
        instructions={scenario.aiInstructions}
        rubric={scenario.rubric}
        metadata={scenario.metadata}
        voice={{ name: scenario.voiceName, languageCode: scenario.languageCode }}
        initialSessions={initialSessions}
        sessionsEndpoint={`/api/coaches/${coach.slug}/sessions`}
      />

      <section className="card-section">
        <h2>Schedule</h2>
        <p>{describeSchedule(coach.schedule)}{next ? ` · next: ${next.toUTCString()}` : ''}</p>
      </section>

      <CoachMemoryPanel
        slug={coach.slug}
        initialConsent={consent}
        initialMemories={memories.map(({ embedding, ...rest }) => rest)}
        policy={{ version: CONSENT_POLICY_VERSION, text: CONSENT_POLICY_TEXT }}
      />
    </div>
  );
}
