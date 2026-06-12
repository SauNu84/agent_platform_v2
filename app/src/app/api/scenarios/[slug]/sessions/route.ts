/**
 * /api/scenarios/[slug]/sessions — list (GET) and start a live voice session (POST).
 *
 * POST is the `Join` action. Two modes converge on the same persistence + metering:
 *   - server-driven (default): runs the session through the realtime seam
 *     (mock vendor in dev, OpenAI when REALTIME_VENDOR=openai + key present) and
 *     saves the transcript. This is the verifiable end-to-end path.
 *   - client-driven: the browser ran the session via the same seam and posts its
 *     final `transcript`; we persist + meter it identically.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getScenario } from '@/services/scenarios';
import { runVoiceSession, persistClientSession, clientVendorForEngine, type Vendor } from '@/voice/session-service';
import { resolveTierForUser, resolveSessionEngine } from '@/voice/engine-router';
import { assertWithinCap, CapExceededError } from '@/services/meter';
import { getActor } from '@/services/current-user';
import type { Transcript } from '@/voice/realtime-interface';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const scenario = await getScenario(store, params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const sessions = await store.listSessionsByScenario(scenario.id);
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const scenario = await getScenario(store, params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: { vendor?: string; transcript?: Transcript } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }

  const userId = actor.userId;

  // Monetization guardrail (Slice 2): block Join when the user's voice-minute cap
  // is exhausted. Pre-flight check — mid-session hard-stop is a tracked follow-up.
  try {
    await assertWithinCap(store, userId);
  } catch (e) {
    if (e instanceof CapExceededError) {
      return NextResponse.json({ error: e.message, meter: e.state }, { status: 402 });
    }
    throw e;
  }

  // Tiered/multi-model voice router (SAU-256/258): resolve the engine from the
  // scenario's author-chosen model (metadata._model) AND the viewer's billing
  // tier — free → cost engine, paid → the author's full choice (gating downgrades
  // a premium engine to a same-vendor cost engine for free viewers).
  const tier = await resolveTierForUser(store, userId);
  const modelId = typeof scenario.metadata?._model === 'string' ? scenario.metadata._model : undefined;
  const engine = resolveSessionEngine({ modelId, tier });

  // Vendor selection:
  // - Server-driven path (no transcript body): always mock. Real realtime needs
  //   browser audio (WebRTC mic → client-driven path, SAU-208). Server-side there
  //   is no audio input, so a real adapter returns 0 turns even with a valid key.
  // - Client-driven path (browser ran the session, posting transcript): use the
  //   resolved engine's vendor (key-gated, mock fallback) since the browser
  //   already produced a real transcript on that engine.
  const vendor: Vendor = body.transcript
    ? ((body.vendor as Vendor) ?? clientVendorForEngine(engine.vendor))
    : 'mock';

  try {
    if (body.transcript) {
      const result = await persistClientSession({ store, scenario, vendor, tier, modelId, userId, transcript: body.transcript });
      return NextResponse.json(result, { status: 201 });
    }
    const result = await runVoiceSession({ store, scenario, vendor, tier, modelId, userId });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
