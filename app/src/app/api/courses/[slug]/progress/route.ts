/** /api/courses/[slug]/progress — the user's progress through the course. */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCourse, getCourseProgress } from '@/services/courses';
import { getActor } from '@/services/current-user';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const course = await getCourse(store, params.slug);
  if (!course) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const userId = actor.userId;
  const progress = await getCourseProgress(store, course, userId);
  return NextResponse.json({ progress });
}
