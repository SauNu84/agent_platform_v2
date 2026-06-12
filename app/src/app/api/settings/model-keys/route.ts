/**
 * /api/settings/model-keys — save (PUT) or remove (DELETE) a Scenario AI Model
 * provider API key (OpenAI / Gemini) from Settings → AI Model (SAU-259). On save
 * the key is VALIDATED against the provider; a rejected key is not stored.
 *
 * Raw keys are stored server-side and read ONLY by the realtime token route to
 * mint an ephemeral browser token; they are NEVER returned to a client. Responses
 * carry only the masked view (configured + last4) plus the validation result.
 *
 * ADMIN-ONLY (board, SAU-259): provider keys are platform credentials, so both
 * verbs require the admin role (403 otherwise). The AI Model settings tab is
 * likewise hidden + 404'd for non-admins.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { adminOr403 } from '@/auth/api-guard';
import { saveModelApiKey, deleteModelApiKey, SettingsError } from '@/services/settings';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const gate = await adminOr403();
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    const { view, validation } = await saveModelApiKey(
      getStore(),
      gate.actor.userId,
      String(body?.provider ?? ''),
      String(body?.key ?? ''),
    );
    return NextResponse.json({ key: view, validation });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await adminOr403();
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    await deleteModelApiKey(getStore(), gate.actor.userId, String(body?.provider ?? ''));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
