/** /api/courses/[slug]/progress — the user's progress through the course. */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCourse, getCourseProgress } from '@/services/courses';
import { DEMO_USER_ID } from '@/coach/demo-user';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const course = await getCourse(store, params.slug);
  if (!course) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const userId = req.nextUrl.searchParams.get('userId') ?? DEMO_USER_ID;
  const progress = await getCourseProgress(store, course, userId);
  return NextResponse.json({ progress });
}
