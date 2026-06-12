/**
 * /api/courses/[slug]/sessions — start an in-course session (POST) / list (GET).
 *
 * POST body: { scenarioSlug } — the course item to start. The session is tagged
 * with course_id so it counts toward course progress. Validates the scenario
 * actually belongs to the course (can't smuggle an out-of-course scenario in).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCourse, resolveCourseScenarios } from '@/services/courses';
import { runVoiceSession, persistClientSession, clientVendorForEngine, type Vendor } from '@/voice/session-service';
import { resolveTierForUser, resolveSessionEngine } from '@/voice/engine-router';
import type { Transcript } from '@/voice/realtime-interface';
import { getActor } from '@/services/current-user';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const course = await getCourse(store, params.slug);
  if (!course) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const sessions = await store.listSessionsByCourse(course.id);
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const course = await getCourse(store, params.slug);
  if (!course) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: { scenarioSlug?: string; vendor?: string; transcript?: Transcript } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  if (!body.scenarioSlug) {
    return NextResponse.json({ error: 'scenarioSlug is required (the course item to start)' }, { status: 400 });
  }

  const scenarios = await resolveCourseScenarios(store, course);
  const scenario = scenarios.find((s) => s.slug === body.scenarioSlug);
  if (!scenario) {
    return NextResponse.json({ error: `scenario "${body.scenarioSlug}" is not part of this course` }, { status: 400 });
  }

  const userId = actor.userId;
  const tier = await resolveTierForUser(store, userId); // SAU-256 tiered router
  // SAU-258: honour the scenario's author-chosen engine, gated by viewer tier.
  const modelId = typeof scenario.metadata?._model === 'string' ? scenario.metadata._model : undefined;
  const engine = resolveSessionEngine({ modelId, tier });
  // Server-driven path always uses mock — real realtime needs browser audio (SAU-208).
  const vendor: Vendor = body.transcript
    ? ((body.vendor as Vendor) ?? clientVendorForEngine(engine.vendor))
    : 'mock';

  try {
    const result = body.transcript
      ? await persistClientSession({ store, scenario, vendor, tier, modelId, userId, courseId: course.id, transcript: body.transcript })
      : await runVoiceSession({ store, scenario, vendor, tier, modelId, userId, courseId: course.id });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
