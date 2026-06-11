/**
 * /api/knowledge-bases — list (GET) and create (POST) Knowledge Bases (SAU-243).
 * Gated by `author_content`; list is own-scoped, create attributes ownership to
 * the acting user.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorWithCapability } from '@/auth/api-guard';
import { createKnowledgeBase, listOwnedKnowledgeBases, KnowledgeBaseError } from '@/services/knowledge-base';

export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  const kbs = await listOwnedKnowledgeBases(getStore(), { userId: gate.actor.userId, isAdmin: gate.actor.isAdmin });
  return NextResponse.json({ knowledgeBases: kbs });
}

export async function POST(req: NextRequest) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    const kb = await createKnowledgeBase(
      getStore(),
      { title: body?.title, description: body?.description },
      { ownerUserId: gate.actor.userId },
    );
    return NextResponse.json({ knowledgeBase: kb }, { status: 201 });
  } catch (e) {
    if (e instanceof KnowledgeBaseError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
