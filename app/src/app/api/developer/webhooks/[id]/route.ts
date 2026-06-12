/**
 * DELETE /api/developer/webhooks/[id] — remove a webhook endpoint (SAU-252).
 *
 * Deletes an endpoint the authenticated user owns. A webhook that isn't theirs
 * (or doesn't exist) returns 404 — no ownership leak.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getActor } from '@/services/current-user';
import { deleteWebhook } from '@/services/developer-tools';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  const ok = await deleteWebhook(getStore(), actor.userId, params.id);
  if (!ok) return NextResponse.json({ error: 'webhook not found' }, { status: 404 });
  return NextResponse.json({ ok: true }, { status: 200 });
}
