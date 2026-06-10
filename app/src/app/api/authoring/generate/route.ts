/**
 * POST /api/authoring/generate — AI authoring (Slice 4, SAU-203).
 *
 * Body: { kind: 'scenario' | 'course', topic, role?, difficulty?, scenarioCount?,
 *         visibility?, maxAttempts? }
 *
 * Returns the validated-but-UNPUBLISHED draft: the generated MD plus the compile
 * result. It NEVER writes the DB — publishing is a separate, approval-gated step
 * (POST /api/authoring/publish). A draft that failed validation comes back with
 * `ok: false` and actionable `errors` (HTTP 422) so the caller can surface them.
 */
import { NextRequest, NextResponse } from 'next/server';
import { generateScenarioDraft, generateCourseDraft } from '@/authoring/pipeline';
import type { AuthoringBrief } from '@/authoring/author';
import { actorWithCapability } from '@/auth/api-guard';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (!topic) {
    return NextResponse.json({ error: '`topic` is required' }, { status: 400 });
  }
  const kind = body.kind === 'course' ? 'course' : 'scenario';
  const brief: AuthoringBrief = {
    topic,
    role: typeof body.role === 'string' ? body.role : undefined,
    difficulty: typeof body.difficulty === 'string' ? body.difficulty : undefined,
    scenarioCount: typeof body.scenarioCount === 'number' ? body.scenarioCount : undefined,
    visibility: body.visibility === 'public' ? 'public' : 'private',
  };
  const maxAttempts = typeof body.maxAttempts === 'number' ? body.maxAttempts : undefined;

  try {
    const draft = kind === 'course'
      ? await generateCourseDraft(brief, { maxAttempts })
      : await generateScenarioDraft(brief, { maxAttempts });
    // Validation failure is a 422 (the generation didn't meet the schema), but
    // the draft body is still returned so the caller sees the actionable errors.
    return NextResponse.json({ draft }, { status: draft.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
