/**
 * Course Library — lists courses (ordered Scenario refs + optional coach). Server
 * component, mirroring the Scenario Library.
 */
import Link from 'next/link';
import { getStore } from '@/db';
import { listCourses } from '@/services/courses';

export const dynamic = 'force-dynamic';

export default async function CoursesPage() {
  const store = getStore();
  const courses = await listCourses(store);

  return (
    <div>
      <h1>Courses</h1>
      <p className="subtitle">An ordered track of scenarios — play them in sequence and track your progress.</p>

      {courses.length === 0 ? (
        <p className="empty">
          No courses yet. Author one as Markdown in <code>content/courses/</code> (list scenario slugs under
          <code> scenarios</code>) and run the compiler, or POST to <code>/api/courses</code>.
        </p>
      ) : (
        <div className="grid">
          {courses.map((c) => (
            <Link key={c.slug} href={`/courses/${c.slug}`} className="card">
              <h3>{c.name}</h3>
              <div className="badges">
                <span className={`badge ${c.isPublic ? 'public' : ''}`}>{c.isPublic ? 'Public' : 'Private'}</span>
                <span className="badge">{c.scenarioIds.length} scenarios</span>
                {c.coachId && <span className="badge">coached</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
