/**
 * Scenario Library — search + Featured/My Scenarios tabs + role filter chips.
 * Featured = system/seeded scenarios; My Scenarios = user-created (metadata._source = 'user').
 */
import Link from 'next/link';
import { getStore } from '@/db';
import type { ScenarioRecord } from '@/domain/scenario';
import { categoryClass } from '@/lib/category';
import { Avatar } from '@/components/Avatar';
import LibrarySearch from './LibrarySearch';

export const dynamic = 'force-dynamic';

function facetValues(scenarios: ScenarioRecord[], key: string): string[] {
  const set = new Set<string>();
  for (const s of scenarios) {
    const v = s.metadata[key];
    if (typeof v === 'string') set.add(v);
  }
  return [...set].sort();
}

function matches(s: ScenarioRecord, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  return (
    s.name.toLowerCase().includes(lower) ||
    (s.description ?? '').toLowerCase().includes(lower) ||
    Object.values(s.metadata).some((v) => typeof v === 'string' && v.toLowerCase().includes(lower))
  );
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: { role?: string; q?: string; tab?: string };
}) {
  const store = getStore();
  const all = await store.listScenarios();

  const activeTab = searchParams.tab === 'my' ? 'my' : 'featured';
  const q = searchParams.q ?? '';
  const activeRole = searchParams.role;

  const featured = all.filter((s) => s.metadata._source !== 'user');
  const mine = all.filter((s) => s.metadata._source === 'user');
  const tabScenarios = activeTab === 'my' ? mine : featured;
  const roles = facetValues(featured, 'role');

  const scenarios = tabScenarios.filter((s) => {
    if (activeRole && s.metadata.role !== activeRole) return false;
    return matches(s, q);
  });

  const tabLink = (label: string, key: string, count: number) => {
    const isActive = activeTab === key;
    const params = new URLSearchParams({ tab: key, ...(q ? { q } : {}) }).toString();
    return (
      <Link key={key} href={`/library?${params}`} className={`lib-tab ${isActive ? 'active' : ''}`}>
        {label}
        {count > 0 && <span className="lib-tab-count">{count}</span>}
      </Link>
    );
  };

  const roleChip = (label: string, params: Record<string, string>, active: boolean) => {
    const qs = new URLSearchParams(params).toString();
    return (
      <Link key={label} href={`/library${qs ? `?${qs}` : ''}`} className={active ? 'active' : ''}>
        {label}
      </Link>
    );
  };

  return (
    <div>
      {/* Create-Scenario CTA removed per SAU-228 (reference parity). */}
      <div className="lib-header">
        <div>
          <h1>Scenario Library</h1>
          <p className="subtitle">Hyper-realistic AI roleplay to practice high-stakes conversations.</p>
        </div>
      </div>

      <LibrarySearch defaultValue={q} totalCount={all.length} />

      <div className="lib-tabs">
        {tabLink('Featured', 'featured', featured.length)}
        {tabLink('My Scenarios', 'my', mine.length)}
      </div>

      {activeTab === 'featured' && roles.length > 0 && (
        <div className="filters">
          {roleChip('All', activeRole ? { tab: 'featured', ...(q ? { q } : {}) } : {}, !activeRole)}
          {roles.map((r) =>
            roleChip(r, { tab: 'featured', role: r, ...(q ? { q } : {}) }, activeRole === r)
          )}
        </div>
      )}

      {/* Create-Scenario CTA lives inside the My Scenarios tab (SAU-237). */}
      {activeTab === 'my' && scenarios.length > 0 && (
        <div className="lib-actions">
          <Link href="/scenarios/create" className="btn">+ Create new scenario</Link>
        </div>
      )}

      {scenarios.length === 0 ? (
        <div className="lib-empty">
          {activeTab === 'my' ? (
            <>
              <p>You haven&apos;t created any scenarios yet.</p>
              <Link href="/scenarios/create" className="btn">+ Create new scenario</Link>
            </>
          ) : (
            <p>No scenarios match your search.</p>
          )}
        </div>
      ) : (
        <div className="grid">
          {scenarios.map((s) => {
            const role = typeof s.metadata.role === 'string' ? s.metadata.role : 'Practice';
            const difficulty = typeof s.metadata.difficulty === 'string' ? s.metadata.difficulty : null;
            return (
              <Link key={s.slug} href={`/scenarios/${s.slug}`} className="card">
                <div className="card-head">
                  <Avatar name={s.name} category={role} slug={s.slug} />
                  <div><h3>{s.name}</h3></div>
                </div>
                {s.description && <p>{s.description}</p>}
                <div className="badges">
                  {s.isPublic && <span className="badge public">Public</span>}
                  <span className={`badge ${categoryClass(role)}`}>{role}</span>
                  {difficulty && <span className="badge">{difficulty}</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
