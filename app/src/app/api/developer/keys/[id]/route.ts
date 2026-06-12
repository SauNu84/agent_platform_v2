/**
 * DELETE /api/developer/keys/[id] — revoke an API key (SAU-252).
 *
 * Soft-deletes (sets revoked_at) a key the authenticated user owns. Idempotent.
 * A key that isn't theirs (or doesn't exist) returns 404 — no ownership leak.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getActor } from '@/services/current-user';
import { revokeApiKey } from '@/services/developer-tools';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  const revoked = await revokeApiKey(getStore(), actor.userId, params.id);
  if (!revoked) return NextResponse.json({ error: 'key not found' }, { status: 404 });
  return NextResponse.json({ id: revoked.id, revokedAt: revoked.revokedAt }, { status: 200 });
}
