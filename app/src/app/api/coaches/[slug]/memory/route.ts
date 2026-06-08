/**
 * /api/coaches/[slug]/memory — user controls over coach memory (ADR-004 DSAR).
 *   GET           → VIEW / EXPORT everything this coach remembers (machine-readable).
 *   DELETE        → WIPE all memory for (coach, user)  [right-to-erasure].
 *   DELETE ?id=…  → delete a single memory.
 * Every action is audited (counts/ids only, no PII content).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCoach } from '@/services/coaches';
import { DEMO_USER_ID } from '@/coach/demo-user';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const userId = req.nextUrl.searchParams.get('userId') ?? DEMO_USER_ID;
  const memories = await store.listCoachMemory(coach.id, userId);
  await store.recordAuditEvent({
    actor: `user:${userId}`, event: 'export', subjectUserId: userId, coachId: coach.id,
    refs: { count: memories.length },
  });
  // Export shape omits the embedding vector (large, internal).
  const exported = memories.map(({ embedding, ...rest }) => rest);
  return NextResponse.json({ coach: coach.slug, userId, memories: exported });
}

export async function DELETE(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const userId = req.nextUrl.searchParams.get('userId') ?? DEMO_USER_ID;
  const id = req.nextUrl.searchParams.get('id');

  if (id) {
    const ok = await store.deleteCoachMemory(coach.id, userId, id);
    await store.recordAuditEvent({
      actor: `user:${userId}`, event: 'memory.delete', subjectUserId: userId, coachId: coach.id,
      refs: { id, deleted: ok },
    });
    if (!ok) return NextResponse.json({ error: 'memory not found' }, { status: 404 });
    return NextResponse.json({ deleted: 1 });
  }

  const purged = await store.wipeCoachMemory(coach.id, userId);
  await store.recordAuditEvent({
    actor: `user:${userId}`, event: 'memory.delete', subjectUserId: userId, coachId: coach.id,
    refs: { wiped: purged },
  });
  return NextResponse.json({ deleted: purged });
}
