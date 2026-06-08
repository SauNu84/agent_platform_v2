/**
 * Course detail — level 1 of the verified 2-level course view: the course page
 * with progress, Play All, and the ordered scenario list. Each item links to the
 * scenario detail (level 2) which reuses the Slice-1 DetailShell.
 */
import { notFound } from 'next/navigation';
import { getStore } from '@/db';
import { getCourse, getCourseProgress } from '@/services/courses';
import CoursePlayer from '@/components/CoursePlayer';
import { DEMO_USER_ID } from '@/coach/demo-user';

export const dynamic = 'force-dynamic';

export default async function CourseDetailPage({ params }: { params: { slug: string } }) {
  const store = getStore();
  const course = await getCourse(store, params.slug);
  if (!course) notFound();

  const progress = await getCourseProgress(store, course, DEMO_USER_ID);
  const coach = course.coachId ? await store.getCoachById(course.coachId) : null;

  return (
    <div>
      <h1>{course.name}</h1>
      <p className="subtitle">
        {course.scenarioIds.length} scenarios · {course.isPublic ? 'Public' : 'Private'}
        {coach ? ` · coached by ${coach.name}` : ''}
      </p>
      <CoursePlayer
        slug={course.slug}
        initialItems={progress.items}
        coachSlug={coach?.slug ?? null}
        coachName={coach?.name ?? null}
      />
    </div>
  );
}
