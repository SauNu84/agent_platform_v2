/**
 * /api/scenarios — list (GET) and create (POST).
 *
 * POST accepts either:
 *   - text/markdown body  → content-as-code compile path (ADR-002), OR
 *   - application/json body (frontmatter-shaped) → validated CRUD create.
 * Both go through the same schema, so the API cannot persist a row the compiler
 * would reject.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import {
  listScenarios, createScenarioFromJson, createScenarioFromMarkdown, ScenarioCompileError,
} from '@/services/scenarios';
import { actorWithCapability } from '@/auth/api-guard';
import { getOwnedKnowledgeBase } from '@/services/knowledge-base';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const store = getStore();
  const sp = req.nextUrl.searchParams;
  const filter: { isPublic?: boolean; metadata?: Record<string, unknown> } = {};
  if (sp.has('public')) filter.isPublic = sp.get('public') === 'true';
  // Any other query params become metadata equality filters (Library "filter by metadata").
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of sp.entries()) {
    if (k === 'public') continue;
    metadata[k] = v;
  }
  if (Object.keys(metadata).length) filter.metadata = metadata;
  const scenarios = await listScenarios(store, filter);
  return NextResponse.json({ scenarios });
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
      const { scenario, created } = await createScenarioFromMarkdown(store, raw, {}, owner);
      return NextResponse.json({ scenario }, { status: created ? 201 : 200 });
    }
    const body = await req.json();
    if (typeof body?.markdown === 'string') {
      const { scenario, created } = await createScenarioFromMarkdown(store, body.markdown, { repoPath: body.repoPath }, owner);
      return NextResponse.json({ scenario }, { status: created ? 201 : 200 });
    }
    const scenario = await createScenarioFromJson(store, body, owner);
    // Auto-link any Knowledge Bases chosen in the form (SAU-243, AC #1). The KB
    // ids ride alongside the frontmatter (Zod strips them from the row); linking
    // is idempotent, so a duplicate/unlinkable id is a harmless no-op.
    const kbIds: string[] = Array.isArray(body?.knowledgeBaseIds)
      ? body.knowledgeBaseIds.filter((x: unknown) => typeof x === 'string')
      : [];
    const kbActor = { userId: gate.actor.userId, isAdmin: gate.actor.isAdmin };
    for (const kbId of kbIds) {
      // Only link KBs the actor may use; skip the rest (idempotent, fail-soft).
      try {
        await getOwnedKnowledgeBase(store, kbId, kbActor);
        await store.linkScenarioKnowledgeBase(scenario.id, kbId);
      } catch { /* unlinkable / not owned — skip */ }
    }
    return NextResponse.json({ scenario }, { status: 201 });
  } catch (e) {
    if (e instanceof ScenarioCompileError) {
      return NextResponse.json({ error: e.message, issues: e.issues }, { status: 422 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
