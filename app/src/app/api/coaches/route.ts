/**
 * /api/coaches — list (GET) and create (POST, Markdown or JSON), mirroring the
 * Scenario API. A coach composes a Scenario by `scenario_ref` (ADR-001).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { listCoaches, createCoachFromMarkdown, createCoachFromJson, CoachCompileError } from '@/services/coaches';
import { actorWithCapability } from '@/auth/api-guard';

export const dynamic = 'force-dynamic';

export async function GET() {
  const coaches = await listCoaches(getStore());
  return NextResponse.json({ coaches });
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
      const { coach, created } = await createCoachFromMarkdown(store, raw, {}, owner);
      return NextResponse.json({ coach }, { status: created ? 201 : 200 });
    }
    const body = await req.json();
    if (typeof body?.markdown === 'string') {
      const { coach, created } = await createCoachFromMarkdown(store, body.markdown, { repoPath: body.repoPath }, owner);
      return NextResponse.json({ coach }, { status: created ? 201 : 200 });
    }
    const coach = await createCoachFromJson(store, body, owner);
    return NextResponse.json({ coach }, { status: 201 });
  } catch (e) {
    if (e instanceof CoachCompileError) {
      return NextResponse.json({ error: e.message, issues: e.issues }, { status: 422 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
