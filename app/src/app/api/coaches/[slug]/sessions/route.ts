/**
 * /api/coaches/[slug]/sessions — list (GET) and Join (POST).
 *
 * POST runs a coach session: retrieve memory → inject → run (mock/OpenAI or a
 * client-posted transcript) → write derived memory (consent-gated, ADR-004).
 * Defaults to the DEMO user so memory is demonstrable before auth lands.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCoach, resolveCoachScenario } from '@/services/coaches';
import { runCoachSession } from '@/voice/coach-session';
import { defaultVendor, type Vendor } from '@/voice/session-service';
import type { Transcript } from '@/voice/realtime-interface';
import { getActor } from '@/services/current-user';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const sessions = await store.listSessionsByCoachUser(coach.id, actor.userId);
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const scenario = await resolveCoachScenario(store, coach);
  if (!scenario) return NextResponse.json({ error: `coach "${coach.slug}" has no composed scenario` }, { status: 409 });

  let body: { vendor?: string; transcript?: Transcript } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }

  const configured = defaultVendor();
  // Server-driven path always uses mock — real OpenAI Realtime needs browser audio (SAU-208).
  const vendor: Vendor = body.transcript
    ? ((body.vendor as Vendor) ?? (process.env.OPENAI_API_KEY ? configured : 'mock'))
    : 'mock';
  const userId = actor.userId;

  try {
    const result = await runCoachSession({ store, coach, scenario, vendor, userId, transcript: body.transcript });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
