/**
 * Scenario Library — list + filter by metadata. Server component: reads straight
 * from the store. Filter facets are derived from the `role` metadata key (the
 * reference product filters by PM / SWE / Leadership / Sales / MBA). Any metadata
 * key works via the API; the UI surfaces `role` as the headline facet.
 */
import Link from 'next/link';
import { getStore } from '@/db';
import type { ScenarioRecord } from '@/domain/scenario';

export const dynamic = 'force-dynamic';

function facetValues(scenarios: ScenarioRecord[], key: string): string[] {
  const set = new Set<string>();
  for (const s of scenarios) {
    const v = s.metadata[key];
    if (typeof v === 'string') set.add(v);
  }
  return [...set].sort();
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: { role?: string; public?: string };
}) {
  const store = getStore();
  const all = await store.listScenarios();
  const roles = facetValues(all, 'role');

  const activeRole = searchParams.role;
  const onlyPublic = searchParams.public === 'true';
  const scenarios = all.filter((s) => {
    if (activeRole && s.metadata.role !== activeRole) return false;
    if (onlyPublic && !s.isPublic) return false;
    return true;
  });

  const chip = (label: string, params: Record<string, string>, active: boolean) => {
    const qs = new URLSearchParams(params).toString();
    return (
      <Link key={label} href={`/library${qs ? `?${qs}` : ''}`} className={active ? 'active' : ''}>
        {label}
      </Link>
    );
  };

  return (
    <div>
      <h1>Scenarios</h1>
      <p className="subtitle">Hyper-realistic AI roleplay to practice high-stakes conversations.</p>

      <div className="filters">
        {chip('All', {}, !activeRole && !onlyPublic)}
        {chip('Public', { public: 'true' }, onlyPublic && !activeRole)}
        {roles.map((r) => chip(r, { role: r }, activeRole === r))}
      </div>

      {scenarios.length === 0 ? (
        <p className="empty">
          No scenarios yet. Author one as Markdown in <code>content/scenarios/</code> and run the compiler,
          or POST to <code>/api/scenarios</code>.
        </p>
      ) : (
        <div className="grid">
          {scenarios.map((s) => (
            <Link key={s.slug} href={`/scenarios/${s.slug}`} className="card">
              <h3>{s.name}</h3>
              {s.description && <p>{s.description}</p>}
              <div className="badges">
                <span className={`badge ${s.isPublic ? 'public' : ''}`}>{s.isPublic ? 'Public' : 'Private'}</span>
                {typeof s.metadata.role === 'string' && <span className="badge">{s.metadata.role}</span>}
                {typeof s.metadata.difficulty === 'string' && <span className="badge">{s.metadata.difficulty}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
