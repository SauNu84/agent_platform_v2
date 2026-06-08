/**
 * POST /api/authoring/publish — the human/coach review gate for AI-authored content.
 *
 * Body: { draft, approvedBy } where `draft` is a draft returned by
 * /api/authoring/generate. Publishing refuses unless an approver is named AND the
 * draft's MD re-compiles cleanly (the route never trusts a client-asserted `ok`
 * flag — it re-validates the exact bytes), then persists via the store.
 *
 * 422 = the (re)validation gate rejected it; 400 = malformed request; 403 = no
 * approver named (review gate not satisfied).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import {
  publishScenarioDraft, publishCourseDraft, AuthoringError,
  ScenarioCompileError, CourseCompileError,
  type ScenarioDraft, type CourseDraft,
} from '@/authoring/pipeline';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const draft = body.draft as (ScenarioDraft | CourseDraft) | undefined;
  const approvedBy = typeof body.approvedBy === 'string' ? body.approvedBy : '';
  if (!draft || (draft.kind !== 'scenario' && draft.kind !== 'course')) {
    return NextResponse.json({ error: '`draft` (a scenario or course draft) is required' }, { status: 400 });
  }
  if (!approvedBy.trim()) {
    return NextResponse.json({ error: 'review gate: `approvedBy` is required to publish AI-authored content' }, { status: 403 });
  }

  const store = getStore();
  try {
    if (draft.kind === 'course') {
      const { course, scenarios } = await publishCourseDraft(store, draft as CourseDraft, { approvedBy });
      return NextResponse.json({ course, scenarios }, { status: 201 });
    }
    const scenario = await publishScenarioDraft(store, draft as ScenarioDraft, { approvedBy });
    return NextResponse.json({ scenario }, { status: 201 });
  } catch (e) {
    if (e instanceof ScenarioCompileError || e instanceof CourseCompileError) {
      return NextResponse.json({ error: e.message, issues: (e as ScenarioCompileError).issues }, { status: 422 });
    }
    if (e instanceof AuthoringError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
