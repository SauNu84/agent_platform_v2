/**
 * /api/sessions/[id]/analyze — run the Analyst worker on a completed session.
 *
 * POST scores the session against its scenario rubric and upserts the `analysis`
 * projection (idempotent). GET returns the existing analysis if one was produced.
 * The worker (`analyzeSession`) is the same function a queue/cron would drive.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { analyzeSession, AnalystError } from '@/services/analyst';
import { getActor } from '@/services/current-user';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const store = getStore();
  // Bind the actor so the `analysis` RLS policy scopes the read to the owner
  // (or an admin). Without this, any caller with a session UUID could read
  // another user's identified report card (SAU-230). Anonymous → no rows → 404.
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const analysis = await store.getAnalysis(params.id);
  if (!analysis) return NextResponse.json({ error: 'not analyzed yet' }, { status: 404 });
  return NextResponse.json({ analysis });
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const store = getStore();
  // Same actor binding for the write path: analyzeSession reads the session
  // (RLS-scoped) and upserts analysis under the owner's user_id; a non-owner
  // sees no session → 404, and the analysis WITH CHECK rejects a foreign write.
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  try {
    const analysis = await analyzeSession(store, params.id);
    return NextResponse.json({ analysis }, { status: 201 });
  } catch (e) {
    if (e instanceof AnalystError) {
      const notFound = /not found/.test(e.message);
      return NextResponse.json({ error: e.message }, { status: notFound ? 404 : 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
