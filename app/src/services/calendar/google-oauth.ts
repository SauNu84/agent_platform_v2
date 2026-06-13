/**
 * google-oauth.ts (SAU-271, Phase 1 · WS2) — Google OAuth 2.0 authorization-code
 * flow for connecting a clinic's REAL Google Calendar.
 *
 * Phase 0 (SAU-267) wrote events with a single short-lived bearer from env. WS2
 * moves to a per-clinic OAuth connection: the clinic owner grants calendar access
 * once, we store an encrypted refresh token (SAU-261 crypto), and we mint fresh
 * access tokens on demand. The token blob never lands in the DB in plaintext and
 * never reaches the browser.
 *
 * KEY-GATED + FAIL-SOFT: the OAuth app credentials (client id/secret) are provided
 * out-of-band via env. Absent ⇒ the connect endpoint reports "not configured" and
 * booking falls back to the env sandbox token or the simulated mock — never a crash
 * (AC #2). SYNTHETIC clinics only this phase (real patient data waits on the HIPAA
 * gate, SAU-272).
 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Read+write events and free/busy for the connected calendar. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the platform's Google OAuth app credentials from env. Returns null when
 * unconfigured so callers can fail soft. The redirect URI is derived per-request
 * from the incoming origin (with a `GOOGLE_OAUTH_REDIRECT_URI` override) so dev
 * tunnels and prod hosts both work without code changes.
 */
export function readGoogleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** The callback path Google redirects back to after consent. */
export const GOOGLE_CALENDAR_CALLBACK_PATH = '/api/integrations/google-calendar/callback';

/** Resolve the registered redirect URI (env override wins; else origin + path). */
export function resolveRedirectUri(origin: string): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI ?? `${origin}${GOOGLE_CALENDAR_CALLBACK_PATH}`;
}

/**
 * Build the Google consent URL. `access_type=offline` + `prompt=consent` ensures we
 * receive a refresh token (Google only returns one on the first consent unless
 * prompt=consent is forced), which is what lets us mint access tokens long-term.
 */
export function buildConsentUrl(cfg: GoogleOAuthConfig, opts: { redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  accessToken: string;
  /** Present on first consent (access_type=offline + prompt=consent). */
  refreshToken: string | null;
  /** Epoch-ms when the access token expires. */
  expiryMs: number;
  scope: string;
}

interface RawTokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function toTokenResponse(body: RawTokenBody, nowMs: number, fallbackRefresh?: string | null): GoogleTokenResponse {
  if (!body.access_token) {
    throw new Error(`google token exchange returned no access_token${body.error ? `: ${body.error}` : ''}`);
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? fallbackRefresh ?? null,
    expiryMs: nowMs + expiresIn * 1000,
    scope: body.scope ?? GOOGLE_CALENDAR_SCOPE,
  };
}

/** Exchange an authorization `code` for an access + refresh token. */
export async function exchangeCodeForTokens(
  cfg: GoogleOAuthConfig,
  code: string,
  redirectUri: string,
  nowMs: number = Date.now(),
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as RawTokenBody;
  if (!res.ok) {
    throw new Error(`google token exchange failed (${res.status})${body.error ? `: ${body.error}` : ''}`);
  }
  return toTokenResponse(body, nowMs);
}

/**
 * Mint a fresh access token from a stored refresh token. Google does not return a
 * new refresh token here, so we carry the existing one forward.
 */
export async function refreshAccessToken(
  cfg: GoogleOAuthConfig,
  refreshToken: string,
  nowMs: number = Date.now(),
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as RawTokenBody;
  if (!res.ok) {
    throw new Error(`google token refresh failed (${res.status})${body.error ? `: ${body.error}` : ''}`);
  }
  return toTokenResponse(body, nowMs, refreshToken);
}
