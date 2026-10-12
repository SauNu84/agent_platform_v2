/**
 * /api/coaches/[slug]/memory — user controls over coach memory (ADR-004 DSAR).
 *   GET           → VIEW / EXPORT everything this coach remembers (machine-readable),
 *                   plus the memory gate's state (`access`, `pausedUntil`, SAU-557).
 *   DELETE        → WIPE all memory for (coach, user)  [right-to-erasure].
 *   DELETE ?id=…  → delete a single memory.
 * Every action is audited (counts/ids only, no PII content). Available on EVERY
 * plan, Free included — never plan-gated (CISO SAU-558 C4).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCoach } from '@/services/coaches';
import { getActor } from '@/services/current-user';
import { viewCoachMemory, deleteCoachMemoryFor } from '@/services/coach-memory-controls';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const view = await viewCoachMemory(store, actor.userId, coach);
  return NextResponse.json({ coach: coach.slug, userId: actor.userId, ...view });
}

export async function DELETE(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const id = req.nextUrl.searchParams.get('id');
  const { deleted, found } = await deleteCoachMemoryFor(store, actor.userId, coach, id);
  if (!found) return NextResponse.json({ error: 'memory not found' }, { status: 404 });
  return NextResponse.json({ deleted });
}
