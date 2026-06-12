/**
 * Coach Library (SAU-249) — a learner-first catalog of AI coaches, rebuilt to
 * mirror the Scenario and Course libraries: a value-led hero, search, and
 * Featured / My Coaches tabs.
 *
 * Product intent (SAU-249): the board asked to replace the old engineering-flavored
 * coach surface with a clean coaching experience at parity with the reference
 * product — "a coach that remembers every session and tracks your progress." We
 * keep our own copy and our existing memory/schedule backend (ADR-004); only the
 * learner-facing framing changes.
 *
 * Featured = platform/seeded coaches (ownerUserId null); My Coaches = coaches the
 * signed-in user authored — the same split the Course Library draws.
 */
import Link from 'next/link';
import { getStore } from '@/db';
import { listCoaches, resolveCoachScenario } from '@/services/coaches';
import { getActor } from '@/services/current-user';
import { describeSchedule } from '@/coach/schedule';
import type { CoachRecord } from '@/domain/coach';
import CoachesSearch from './CoachesSearch';

export const dynamic = 'force-dynamic';

function matches(c: CoachRecord, q: string): boolean {
  if (!q) return true;
  return c.name.toLowerCase().includes(q.toLowerCase());
}

export default async function CoachesPage({
  searchParams,
}: {
  searchParams: { q?: string; tab?: string };
}) {
  const store = getStore();
  const actor = await getActor();
  const all = await listCoaches(store);

  const activeTab = searchParams.tab === 'my' ? 'my' : 'featured';
  const q = searchParams.q ?? '';

  const featured = all.filter((c) => !c.ownerUserId);
  const mine = actor ? all.filter((c) => c.ownerUserId === actor.userId) : [];
  const tabCoaches = activeTab === 'my' ? mine : featured;
  const filtered = tabCoaches.filter((c) => matches(c, q));

  // Resolve each coach's composed scenario for the card blurb / focus badge.
  const cards = await Promise.all(
    filtered.map(async (coach) => ({ coach, scenario: await resolveCoachScenario(store, coach) })),
  );

  const tabLink = (label: string, key: string, count: number) => {
    const isActive = activeTab === key;
    const params = new URLSearchParams({ tab: key, ...(q ? { q } : {}) }).toString();
    return (
      <Link key={key} href={`/coaches?${params}`} className={`lib-tab ${isActive ? 'active' : ''}`}>
        {label}
        {count > 0 && <span className="lib-tab-count">{count}</span>}
      </Link>
    );
  };

  return (
    <div>
      <div className="lib-header">
        <div>
          <h1>Coaches</h1>
          <p className="subtitle">
            Your AI coaches — practice that remembers every session, adapts to you, and tracks your
            progress over time.
          </p>
        </div>
      </div>

      <CoachesSearch defaultValue={q} totalCount={all.length} />

      <div className="lib-tabs">
        {tabLink('Featured', 'featured', featured.length)}
        {tabLink('My Coaches', 'my', mine.length)}
      </div>

      {cards.length === 0 ? (
        <div className="lib-empty">
          {activeTab === 'my' ? (
            <p>You haven&apos;t created any coaches yet.</p>
          ) : (
            <p>No coaches match your search.</p>
          )}
        </div>
      ) : (
        <div className="grid">
          {cards.map(({ coach, scenario }) => (
            <Link key={coach.slug} href={`/coaches/${coach.slug}`} className="card">
              <h3>{coach.name}</h3>
              {scenario?.description && <p>{scenario.description}</p>}
              <div className="badges">
                <span className="badge">🧠 remembers you</span>
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
