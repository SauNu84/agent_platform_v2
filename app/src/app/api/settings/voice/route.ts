/**
 * /api/settings/voice — create/update (PUT) or remove (DELETE) the user's voice
 * profile (SAU-253). Persists the profile label + a 'pending' status; live voice
 * synthesis (Cartesia) activation is a follow-up. Own-scoped by userId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorOr401 } from '@/auth/api-guard';
import { saveVoiceProfile, deleteVoiceProfile, SettingsError } from '@/services/settings';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    const profile = await saveVoiceProfile(getStore(), gate.actor.userId, String(body?.name ?? ''));
    return NextResponse.json({ profile });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE() {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  await deleteVoiceProfile(getStore(), gate.actor.userId);
  return NextResponse.json({ ok: true });
}
