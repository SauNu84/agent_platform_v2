/**
 * GET /api/auth/me — the authenticated actor (identity + role + capabilities),
 * or 401 if not logged in. Handy for client-side gating / debugging.
 */
import { NextResponse } from 'next/server';
import { getActor } from '@/services/current-user';

export const dynamic = 'force-dynamic';

export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  return NextResponse.json({
    user: {
      id: actor.userId,
      email: actor.email,
      displayName: actor.displayName,
      role: actor.role,
      capabilities: actor.capabilities,
      isAdmin: actor.isAdmin,
    },
  });
}
