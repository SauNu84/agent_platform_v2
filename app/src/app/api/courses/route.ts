/**
 * /api/courses — list (GET) and create (POST, Markdown or JSON), mirroring the
 * Scenario API. A course is an ordered list of `scenarios:` refs (ADR-001).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { listCourses, createCourseFromMarkdown, createCourseFromJson, CourseCompileError } from '@/services/courses';
import { actorWithCapability } from '@/auth/api-guard';

export const dynamic = 'force-dynamic';

export async function GET() {
  const courses = await listCourses(getStore());
  return NextResponse.json({ courses });
}

export async function POST(req: NextRequest) {
  const store = getStore();
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  const owner = { ownerUserId: gate.actor.userId };
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('markdown') || contentType.includes('text/plain')) {
      const raw = await req.text();
      const { course, created } = await createCourseFromMarkdown(store, raw, {}, owner);
      return NextResponse.json({ course }, { status: created ? 201 : 200 });
    }
    const body = await req.json();
    if (typeof body?.markdown === 'string') {
      const { course, created } = await createCourseFromMarkdown(store, body.markdown, { repoPath: body.repoPath }, owner);
      return NextResponse.json({ course }, { status: created ? 201 : 200 });
    }
    const course = await createCourseFromJson(store, body, owner);
    return NextResponse.json({ course }, { status: 201 });
  } catch (e) {
    if (e instanceof CourseCompileError) {
      return NextResponse.json({ error: e.message, issues: e.issues }, { status: 422 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
