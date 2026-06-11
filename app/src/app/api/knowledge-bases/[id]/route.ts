/**
 * /api/knowledge-bases/[id] — get one (GET, with its documents) and delete (DELETE).
 * Owner/admin only (SAU-243).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorWithCapability } from '@/auth/api-guard';
import { getOwnedKnowledgeBase, deleteKnowledgeBase, KnowledgeBaseError } from '@/services/knowledge-base';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  const store = getStore();
  try {
    const kb = await getOwnedKnowledgeBase(store, params.id, { userId: gate.actor.userId, isAdmin: gate.actor.isAdmin });
    const documents = await store.listKnowledgeBaseDocuments(kb.id);
    // Don't ship the full extracted text in the management view — summaries only.
    return NextResponse.json({
      knowledgeBase: kb,
      documents: documents.map((d) => ({ id: d.id, filename: d.filename, contentType: d.contentType, chars: d.chars, byteSize: d.byteSize, createdAt: d.createdAt })),
    });
  } catch (e) {
    if (e instanceof KnowledgeBaseError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  try {
    await deleteKnowledgeBase(getStore(), params.id, { userId: gate.actor.userId, isAdmin: gate.actor.isAdmin });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    if (e instanceof KnowledgeBaseError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
