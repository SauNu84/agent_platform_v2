/**
 * Coach detail (SAU-249) — a learner-first coaching experience at parity with the
 * reference product. The shared DetailShell still drives the briefing + the live
 * session/transcript history, but we wrap it with the three things that make a
 * Coach feel like a coach rather than a one-off scenario:
 *
 *   1. "How your coach works" value strip — remembers you · adapts to you · tracks progress.
 *   2. "Your progress" — sessions completed + last session, the accountability hook.
 *   3. "Your coaching cadence" — the friendly schedule.
 *
 * The consent / DSAR memory controls (ADR-004, CISO-signed) are kept intact but
 * repositioned into a collapsed "Memory & privacy" disclosure, mirroring the
 * SAU-246 move that hid scenario config behind a "Scenario setup" disclosure —
 * lead with learner value, keep the compliance surface one click away.
 */
import { notFound } from 'next/navigation';
import { getStore } from '@/db';
import DetailShell, { type SessionSummary } from '@/components/DetailShell';
import CoachMemoryPanel from '@/components/CoachMemoryPanel';
import { getCoach, resolveCoachScenario } from '@/services/coaches';
import { getCoachConsent, CONSENT_POLICY_TEXT, CONSENT_POLICY_VERSION } from '@/coach/consent';
import { describeSchedule, nextOccurrence } from '@/coach/schedule';
import { requirePageActor } from '@/services/current-user';

export const dynamic = 'force-dynamic';

export default async function CoachDetailPage({ params }: { params: { slug: string } }) {
  const store = getStore();
  const { userId } = await requirePageActor();
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

  const sessions = await store.listSessionsByCoachUser(coach.id, userId);
  const initialSessions: SessionSummary[] = sessions.map((s) => ({
    id: s.id, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, turns: s.transcript?.turns ?? [],
  }));

  const consent = await getCoachConsent(store, userId, coach.id);
  const memories = await store.listCoachMemory(coach.id, userId);
  const next = nextOccurrence(coach.schedule, Date.now());

  // Progress signals — the accountability hook a coach adds over a one-off scenario.
  const completed = initialSessions.filter((s) => s.status === 'completed' || Boolean(s.endedAt)).length;
  const lastStartedAt = initialSessions
    .map((s) => s.startedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const lastSession = lastStartedAt ? new Date(lastStartedAt).toLocaleDateString() : '—';

  return (
    <div>
      {/* How your coach works — the parity framing that sets a Coach apart from a Scenario. */}
      <div className="badges" style={{ marginBottom: 18 }}>
        <span className="badge">🧠 Remembers every session</span>
        <span className="badge">🎯 Adapts to you</span>
        <span className="badge">📈 Tracks your progress</span>
      </div>

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

      {/* Your progress — sessions completed + last session + what's next. */}
      <section className="card-section">
        <h2>Your progress</h2>
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-value">{initialSessions.length}</div>
            <div className="kpi-label">Sessions with this coach</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">{completed}</div>
            <div className="kpi-label">Completed</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">{lastSession}</div>
            <div className="kpi-label">Last session</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-value">{memories.length}</div>
            <div className="kpi-label">Things your coach remembers</div>
          </div>
        </div>
      </section>

      {/* Your coaching cadence — the schedule, framed as a recurring commitment. */}
      <section className="card-section">
        <h2>Your coaching cadence</h2>
        <p>
          {describeSchedule(coach.schedule)}
          {next ? ` · next session: ${next.toUTCString()}` : ''}
        </p>
      </section>

      {/* Memory & privacy — consent / DSAR controls (ADR-004), kept intact but
          collapsed by default so the learner experience leads (SAU-246 pattern). */}
      <details className="setup" style={{ marginTop: 28 }}>
        <summary>
          Memory &amp; privacy <span className="setup-hint">— what this coach remembers, and your controls</span>
        </summary>
        <div className="setup-body">
          <CoachMemoryPanel
            slug={coach.slug}
            initialConsent={consent}
            initialMemories={memories.map(({ embedding, ...rest }) => rest)}
            policy={{ version: CONSENT_POLICY_VERSION, text: CONSENT_POLICY_TEXT }}
          />
        </div>
      </details>
    </div>
  );
}
