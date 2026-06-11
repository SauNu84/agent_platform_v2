/**
 * DELETE /api/scenarios/[slug]/knowledge-bases/[kbId] — unlink a KB from a
 * scenario (SAU-243). Removes the ASSOCIATION only; the KB itself survives.
 * Requires the actor to own (or admin) the scenario.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorWithCapability } from '@/auth/api-guard';
import { getScenario } from '@/services/scenarios';
import { unlinkFromScenario } from '@/services/knowledge-base';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: { slug: string; kbId: string } }) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;
  const store = getStore();
  const actor = { userId: gate.actor.userId, isAdmin: gate.actor.isAdmin };
  const scenario = await getScenario(store, params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!actor.isAdmin && scenario.ownerUserId !== null && scenario.ownerUserId !== actor.userId) {
    return NextResponse.json({ error: 'You do not own this scenario.' }, { status: 403 });
  }
  const unlinked = await unlinkFromScenario(store, scenario.id, params.kbId);
  return NextResponse.json({ unlinked });
}
