/**
 * /api/coaches/[slug]/consent — the consent gate for coach memory (ADR-004).
 *   GET  → current consent state + the exact policy text/version shown.
 *   POST → record a grant/revoke (append-only). Body: { consentType, action }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCoach } from '@/services/coaches';
import {
  recordConsentChange, getCoachConsent, CONSENT_POLICY_TEXT, CONSENT_POLICY_VERSION,
} from '@/coach/consent';
import { getActor } from '@/services/current-user';
import type { ConsentType } from '@/db/store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const userId = actor.userId;
  const state = await getCoachConsent(store, userId, coach.id);
  return NextResponse.json({ state, policy: { version: CONSENT_POLICY_VERSION, text: CONSENT_POLICY_TEXT } });
}

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const coach = await getCoach(store, params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: { consentType?: ConsentType; action?: 'granted' | 'revoked' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const { consentType, action } = body;
  if (consentType !== 'persistent_memory' && consentType !== 'audio_retention') {
    return NextResponse.json({ error: 'consentType must be persistent_memory | audio_retention' }, { status: 400 });
  }
  if (action !== 'granted' && action !== 'revoked') {
    return NextResponse.json({ error: 'action must be granted | revoked' }, { status: 400 });
  }
  const userId = actor.userId;
  const state = await recordConsentChange({ store, userId, coachId: coach.id, consentType, action });
  return NextResponse.json({ state }, { status: 201 });
}
