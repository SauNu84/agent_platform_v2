import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCourse, deleteCourse } from '@/services/courses';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const course = await getCourse(getStore(), params.slug);
  if (!course) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ course });
}

export async function DELETE(_req: NextRequest, { params }: { params: { slug: string } }) {
  const ok = await deleteCourse(getStore(), params.slug);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
