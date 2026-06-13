/**
 * GET /api/integrations/google-calendar/callback (SAU-271, Phase 1 · WS2) — Google
 * redirects here after consent. We verify the `state` is bound to the signed-in
 * actor (CSRF), exchange the `code` for tokens, store them ENCRYPTED at rest
 * (SAU-261), and bounce back to Settings → Integrations with a status flag.
 *
 * Every failure path redirects back with `?calendar=<reason>` rather than dumping a
 * raw error page, so a denied consent or misconfig degrades gracefully (AC #2).
 */
import { NextRequest, NextResponse } from 'next/server';
import { actorOr401 } from '@/auth/api-guard';
import { getStore } from '@/db';
import { readGoogleOAuthConfig, exchangeCodeForTokens, resolveRedirectUri } from '@/services/calendar/google-oauth';
import { verifyOAuthState, saveGoogleConnection } from '@/services/calendar/calendar-connection';

export const dynamic = 'force-dynamic';

function back(origin: string, status: string): NextResponse {
  return NextResponse.redirect(`${origin}/settings/integrations?calendar=${encodeURIComponent(status)}`);
}

export async function GET(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;

  const origin = new URL(req.url).origin;
  const params = req.nextUrl.searchParams;

  if (params.get('error')) return back(origin, 'denied');

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return back(origin, 'invalid');

  const verified = verifyOAuthState(state, gate.actor.userId);
  if (!verified) return back(origin, 'state_mismatch');

  const cfg = readGoogleOAuthConfig();
  if (!cfg) return back(origin, 'not_configured');

  try {
    const tokens = await exchangeCodeForTokens(cfg, code, resolveRedirectUri(origin));
    await saveGoogleConnection(getStore(), gate.actor.userId, tokens, verified.calendarId);
    return back(origin, 'connected');
  } catch (e) {
    console.warn('[calendar] OAuth callback failed:', (e as Error).message);
    return back(origin, 'error');
  }
}
