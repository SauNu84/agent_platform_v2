/**
 * /api/courses — list (GET) and create (POST, Markdown or JSON), mirroring the
 * Scenario API. A course is an ordered list of `scenarios:` refs (ADR-001).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { listCourses, createCourseFromMarkdown, createCourseFromJson, CourseCompileError } from '@/services/courses';

export const dynamic = 'force-dynamic';

export async function GET() {
  const courses = await listCourses(getStore());
  return NextResponse.json({ courses });
}

export async function POST(req: NextRequest) {
  const store = getStore();
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('markdown') || contentType.includes('text/plain')) {
      const raw = await req.text();
      const { course, created } = await createCourseFromMarkdown(store, raw);
      return NextResponse.json({ course }, { status: created ? 201 : 200 });
    }
    const body = await req.json();
    if (typeof body?.markdown === 'string') {
      const { course, created } = await createCourseFromMarkdown(store, body.markdown, { repoPath: body.repoPath });
      return NextResponse.json({ course }, { status: created ? 201 : 200 });
    }
    const course = await createCourseFromJson(store, body);
    return NextResponse.json({ course }, { status: 201 });
  } catch (e) {
    if (e instanceof CourseCompileError) {
      return NextResponse.json({ error: e.message, issues: e.issues }, { status: 422 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
