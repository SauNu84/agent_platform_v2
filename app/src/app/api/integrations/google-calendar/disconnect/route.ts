/**
 * POST /api/integrations/google-calendar/disconnect (SAU-271, Phase 1 · WS2) —
 * remove the clinic's stored Google Calendar OAuth connection (and its encrypted
 * tokens). After this, booking falls back to the sandbox token or simulated mock.
 * Own-scoped by the signed-in actor.
 */
import { NextRequest, NextResponse } from 'next/server';
import { actorOr401 } from '@/auth/api-guard';
import { getStore } from '@/db';
import { clearGoogleConnection, getCalendarConnectionView } from '@/services/calendar/calendar-connection';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  await clearGoogleConnection(getStore(), gate.actor.userId);
  const connection = await getCalendarConnectionView(getStore(), gate.actor.userId);
  return NextResponse.json({ connection });
}
