/**
 * Course Library — search + Featured/My Courses tabs + Create Course CTA, built
 * to mirror the Scenario Library (/library) per SAU-247. Server component.
 *
 * Featured = platform/seeded courses (ownerUserId null); My Courses = courses the
 * signed-in user authored (ownerUserId === actor.userId), the same Featured/Mine
 * split the Scenario Library draws with `metadata._source`.
 */
import Link from 'next/link';
import { getStore } from '@/db';
import { listCourses } from '@/services/courses';
import { getActor } from '@/services/current-user';
import type { CourseRecord } from '@/domain/course';
import CoursesSearch from './CoursesSearch';
import { CourseCover } from '@/components/CourseCover';

export const dynamic = 'force-dynamic';

function matches(c: CourseRecord, q: string): boolean {
  if (!q) return true;
  return c.name.toLowerCase().includes(q.toLowerCase());
}

export default async function CoursesPage({
  searchParams,
}: {
  searchParams: { q?: string; tab?: string };
}) {
  const store = getStore();
  const actor = await getActor();
  const all = await listCourses(store);

  const activeTab = searchParams.tab === 'my' ? 'my' : 'featured';
  const q = searchParams.q ?? '';

  const featured = all.filter((c) => !c.ownerUserId);
  const mine = actor ? all.filter((c) => c.ownerUserId === actor.userId) : [];
  const tabCourses = activeTab === 'my' ? mine : featured;
  const courses = tabCourses.filter((c) => matches(c, q));

  const tabLink = (label: string, key: string, count: number) => {
    const isActive = activeTab === key;
    const params = new URLSearchParams({ tab: key, ...(q ? { q } : {}) }).toString();
    return (
      <Link key={key} href={`/courses?${params}`} className={`lib-tab ${isActive ? 'active' : ''}`}>
        {label}
        {count > 0 && <span className="lib-tab-count">{count}</span>}
      </Link>
    );
  };

  return (
    <div>
      <div className="lib-header">
        <div>
          <h1>Courses</h1>
          <p className="subtitle">An ordered track of scenarios — play them in sequence and track your progress.</p>
        </div>
      </div>

      <CoursesSearch defaultValue={q} totalCount={all.length} />

      <div className="lib-tabs">
        {tabLink('Featured', 'featured', featured.length)}
        {tabLink('My Courses', 'my', mine.length)}
      </div>

      {/* Create-Course CTA lives in the My Courses tab (mirrors Scenario Library, SAU-237). */}
      {activeTab === 'my' && courses.length > 0 && (
        <div className="lib-actions">
          <Link href="/courses/create" className="btn">+ Create new course</Link>
        </div>
      )}

      {courses.length === 0 ? (
        <div className="lib-empty">
          {activeTab === 'my' ? (
            <>
              <p>You haven&apos;t created any courses yet.</p>
              <Link href="/courses/create" className="btn">+ Create new course</Link>
            </>
          ) : (
            <p>No courses match your search.</p>
          )}
        </div>
      ) : (
        <div className="grid">
          {courses.map((c) => (
            <Link key={c.slug} href={`/courses/${c.slug}`} className="card">
              <CourseCover name={c.name} slug={c.slug} coverImageUrl={c.coverImageUrl} height={120} />
              <h3 style={{ marginTop: 10 }}>{c.name}</h3>
              <div className="badges">
                <span className={`badge ${c.isPublic ? 'public' : ''}`}>{c.isPublic ? 'Public' : 'Private'}</span>
                <span className="badge">{c.scenarioIds.length} scenario{c.scenarioIds.length === 1 ? '' : 's'}</span>
                {c.coachId && <span className="badge">coached</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
