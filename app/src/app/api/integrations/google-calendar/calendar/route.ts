/**
 * POST /api/integrations/google-calendar/calendar (SAU-297) — switch the target
 * calendar of the connected Google account in place (no re-consent). Bookings then
 * land in the chosen calendar. Own-scoped by userId; 409 when nothing is connected.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorOr401 } from '@/auth/api-guard';
import { setConnectionCalendarId, getCalendarConnectionView } from '@/services/calendar/calendar-connection';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { calendarId?: unknown };
  const calendarId = typeof body.calendarId === 'string' ? body.calendarId.trim() : '';
  if (!calendarId) return NextResponse.json({ error: 'A target calendar id is required.' }, { status: 400 });

  const store = getStore();
  const ok = await setConnectionCalendarId(store, gate.actor.userId, calendarId);
  if (!ok) {
    return NextResponse.json({ error: 'Connect a Google Calendar before choosing a target calendar.' }, { status: 409 });
  }
  const connection = await getCalendarConnectionView(store, gate.actor.userId);
  return NextResponse.json({ connection });
}
