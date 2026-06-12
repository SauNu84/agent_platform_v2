/**
 * GET /api/voice/usage (SAU-257) — the authenticated user's live voice-minute
 * meter for the current month.
 *
 * Surfaces the "remaining minutes" read (AC#2) that the UI shows in Settings and
 * before/within a voice session, plus the per-tier policy (engine, monthly +
 * per-session caps, exhaustion behaviour) so the client can render the cap UX and
 * the graceful text-Chat fallback without re-deriving any of it.
 *
 * Read-only; no metering side-effects. Mirrors the Join pre-flight (services/meter).
 */
import { NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getActor } from '@/services/current-user';
import { getMeterState } from '@/services/meter';

export const dynamic = 'force-dynamic';

export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const meter = await getMeterState(getStore(), actor.userId);
  return NextResponse.json({ meter });
}
