/**
 * GET /api/integrations/google-calendar/connect (SAU-271, Phase 1 · WS2) —
 * kick off the Google Calendar OAuth consent flow for the signed-in clinic owner.
 *
 * Builds the consent URL with a self-verifying `state` bound to the actor and 302s
 * to Google. Key-gated: when the platform OAuth app isn't configured we 503 with a
 * clear message instead of sending the user to a broken consent screen (AC #2).
 * `?calendarId=` lets the clinic target a specific calendar (defaults to primary).
 */
import { NextRequest, NextResponse } from 'next/server';
import { actorOr401 } from '@/auth/api-guard';
import { readGoogleOAuthConfig, buildConsentUrl, resolveRedirectUri } from '@/services/calendar/google-oauth';
import { buildOAuthState } from '@/services/calendar/calendar-connection';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;

  const cfg = readGoogleOAuthConfig();
  if (!cfg) {
    return NextResponse.json(
      {
        error:
          'Google Calendar OAuth is not configured on this server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET). ' +
          'Booking will use the simulated sandbox calendar until it is connected.',
      },
      { status: 503 },
    );
  }

  const origin = new URL(req.url).origin;
  const calendarId = req.nextUrl.searchParams.get('calendarId')?.trim() || 'primary';
  // Optional same-origin path to return to after consent (defaults to Settings →
  // Integrations in the callback). The demo config panel passes its own path.
  const returnTo = req.nextUrl.searchParams.get('returnTo');
  const state = buildOAuthState(gate.actor.userId, calendarId, returnTo);
  const consentUrl = buildConsentUrl(cfg, { redirectUri: resolveRedirectUri(origin), state });
  return NextResponse.redirect(consentUrl);
}
