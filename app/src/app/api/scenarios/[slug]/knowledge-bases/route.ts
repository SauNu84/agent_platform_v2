/**
 * /api/scenarios/[slug]/knowledge-bases — list linked (GET) and link (POST) a KB
 * to a scenario (SAU-243). Linking requires the actor to own (or admin) the
 * scenario; the association is many-to-many and idempotent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorWithCapability } from '@/auth/api-guard';
import { getScenario } from '@/services/scenarios';
import { getOwnedKnowledgeBase, linkToScenario, KnowledgeBaseError } from '@/services/knowledge-base';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  const store = getStore();
  const scenario = await getScenario(store, params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const knowledgeBases = await store.listScenarioKnowledgeBases(scenario.id);
  return NextResponse.json({ knowledgeBases });
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  const store = getStore();
  const actor = { userId: gate.actor.userId, isAdmin: gate.actor.isAdmin };
  const scenario = await getScenario(store, params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!actor.isAdmin && scenario.ownerUserId !== null && scenario.ownerUserId !== actor.userId) {
    return NextResponse.json({ error: 'You do not own this scenario.' }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const kbId = typeof body?.kbId === 'string' ? body.kbId : '';
    if (!kbId) return NextResponse.json({ error: '`kbId` is required' }, { status: 422 });
    // Confirm the KB exists and the actor may use it before linking.
    await getOwnedKnowledgeBase(store, kbId, actor);
    await linkToScenario(store, scenario.id, kbId);
    const knowledgeBases = await store.listScenarioKnowledgeBases(scenario.id);
    return NextResponse.json({ knowledgeBases }, { status: 201 });
  } catch (e) {
    if (e instanceof KnowledgeBaseError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
