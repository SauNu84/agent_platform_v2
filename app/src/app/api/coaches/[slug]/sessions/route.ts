/**
 * /api/coaches/[slug]/sessions — list (GET) and Join (POST).
 *
 * POST runs a coach session: retrieve memory → inject → run (mock/OpenAI or a
 * client-posted transcript) → write derived memory. Memory runs only on a plan that
 * includes it AND with consent (SAU-557 planFeatures + ADR-004).
 * Defaults to the DEMO user so memory is demonstrable before auth lands.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCoach, resolveCoachScenario } from '@/services/coaches';
import { runCoachSession } from '@/voice/coach-session';
import { clientVendorForEngine, type Vendor } from '@/voice/session-service';
import { resolveVoiceTier, resolveSessionEngine } from '@/voice/engine-router';
import { resolvePlanTierForUser } from '@/voice/plan-features';
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

  const userId = actor.userId;
  const planTier = await resolvePlanTierForUser(store, userId); // SAU-557 feature gate
  const tier = resolveVoiceTier(planTier); // SAU-256 tiered router
  // SAU-258: honour the scenario's author-chosen engine, gated by viewer tier.
  const modelId = typeof scenario.metadata?._model === 'string' ? scenario.metadata._model : undefined;
  const engine = resolveSessionEngine({ modelId, tier });
  // Server-driven path always uses mock — real realtime needs browser audio (SAU-208).
  const vendor: Vendor = body.transcript
    ? ((body.vendor as Vendor) ?? clientVendorForEngine(engine.vendor))
    : 'mock';

  try {
    const result = await runCoachSession({ store, coach, scenario, vendor, tier, planTier, modelId, userId, transcript: body.transcript });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
