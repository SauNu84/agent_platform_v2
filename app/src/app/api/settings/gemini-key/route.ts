/**
 * /api/settings/gemini-key — save (PUT) or remove (DELETE) the live-voice (Gemini)
 * API key from Settings → My Voice (SAU-259). Lets the board self-provision the key
 * ("Check the setting") instead of editing app/.env.local.
 *
 * The raw key is stored server-side and read ONLY by the realtime token route to
 * mint an ephemeral browser token; it is NEVER returned to a client. Responses here
 * carry only the masked view (configured + last4). Own-scoped by userId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorOr401 } from '@/auth/api-guard';
import { saveGeminiLiveKey, deleteGeminiLiveKey, SettingsError } from '@/services/settings';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    const view = await saveGeminiLiveKey(getStore(), gate.actor.userId, String(body?.key ?? ''));
    return NextResponse.json({ key: view });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE() {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  await deleteGeminiLiveKey(getStore(), gate.actor.userId);
  return NextResponse.json({ ok: true });
}
