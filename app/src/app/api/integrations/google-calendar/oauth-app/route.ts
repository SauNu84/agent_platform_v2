/**
 * /api/integrations/google-calendar/oauth-app (SAU-297 follow-up) — provide (PUT)
 * or clear (DELETE) the Google OAuth APP credentials (client id + secret) from the
 * UI, so the demo can be set up without editing `.env`. The secret is encrypted at
 * rest and never returned to a client (only a masked view).
 *
 * ADMIN-ONLY: OAuth app credentials are platform credentials, mirroring the
 * Scenario AI Model keys (SAU-259). An env-provisioned config still takes precedence.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { adminOr403 } from '@/auth/api-guard';
import { saveGoogleOAuthApp, clearGoogleOAuthApp, GoogleOAuthAppError } from '@/services/calendar/google-oauth-config';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const gate = await adminOr403();
  if ('response' in gate) return gate.response;
  try {
    const body = (await req.json().catch(() => ({}))) as { clientId?: unknown; clientSecret?: unknown };
    const origin = new URL(req.url).origin;
    const oauthApp = await saveGoogleOAuthApp(getStore(), gate.actor.userId, origin, body.clientId, body.clientSecret);
    return NextResponse.json({ oauthApp });
  } catch (e) {
    if (e instanceof GoogleOAuthAppError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await adminOr403();
  if ('response' in gate) return gate.response;
  const origin = new URL(req.url).origin;
  const oauthApp = await clearGoogleOAuthApp(getStore(), gate.actor.userId, origin);
  return NextResponse.json({ oauthApp });
}
