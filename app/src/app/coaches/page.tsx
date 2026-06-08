/**
 * Coach Library — lists coaches (Scenario + memory + schedule). Server component,
 * mirroring the Scenario Library. Each card shows the composed scenario and the
 * recurrence summary.
 */
import Link from 'next/link';
import { getStore } from '@/db';
import { listCoaches, resolveCoachScenario } from '@/services/coaches';
import { describeSchedule } from '@/coach/schedule';

export const dynamic = 'force-dynamic';

export default async function CoachesPage() {
  const store = getStore();
  const coaches = await listCoaches(store);
  const cards = await Promise.all(
    coaches.map(async (coach) => ({ coach, scenario: await resolveCoachScenario(store, coach) })),
  );

  return (
    <div>
      <h1>Coaches</h1>
      <p className="subtitle">A scenario that remembers you across sessions — and shows up on a schedule.</p>

      {cards.length === 0 ? (
        <p className="empty">
          No coaches yet. Author one as Markdown in <code>content/coaches/</code> (reference a scenario with
          <code> scenario_ref</code>) and run the compiler, or POST to <code>/api/coaches</code>.
        </p>
      ) : (
        <div className="grid">
          {cards.map(({ coach, scenario }) => (
            <Link key={coach.slug} href={`/coaches/${coach.slug}`} className="card">
              <h3>{coach.name}</h3>
              {scenario?.description && <p>{scenario.description}</p>}
              <div className="badges">
                <span className="badge">memory: {coach.retention}</span>
                <span className="badge">{describeSchedule(coach.schedule)}</span>
                {scenario && <span className="badge">{scenario.name}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
