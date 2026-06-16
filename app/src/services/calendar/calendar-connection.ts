/**
 * calendar-connection.ts (SAU-271, Phase 1 · WS2) — per-clinic Google Calendar
 * OAuth connection, persisted with the token blob ENCRYPTED AT REST (SAU-261).
 *
 * Grain: one connection per user (the clinic owner/operator) in the RLS-protected
 * `user_setting` table (migration 0015 FORCE RLS). A true multi-tenant `clinic`
 * entity is a later refinement; for the synthetic WS2 spike the operating user IS
 * the clinic. The access/refresh tokens live inside one AES-256-GCM ciphertext
 * field; display metadata (calendarId, scope, connectedAt) stays plaintext.
 *
 * The OAuth CSRF `state` is itself an encrypted, self-verifying token binding the
 * flow to the initiating user — no extra server-side state row needed.
 */
import { randomBytes } from 'node:crypto';
import type { Store } from '@/db/store';
import { encrypt, decrypt } from '@/lib/crypto';
import { refreshAccessToken, type GoogleTokenResponse } from './google-oauth';
import { resolveGoogleOAuthConfig } from './google-oauth-config';

/** user_setting key for the Google Calendar OAuth connection (distinct from the
 *  SAU-253 `integration:calendar` provider-choice record so neither clobbers the
 *  other). */
export const CALENDAR_OAUTH_KEY = 'calendar_oauth:google';

/** Refresh the access token when it's within this window of expiring. */
const REFRESH_SKEW_MS = 60_000;

export interface GoogleCalendarConnection {
  calendarId: string;
  scope: string;
  connectedAt: string;
  tokens: GoogleTokenResponse;
}

interface StoredTokenBlob {
  accessToken: string;
  refreshToken: string | null;
  expiryMs: number;
  scope: string;
}

/** Persist (or replace) the connection, encrypting the token blob at rest. */
export async function saveGoogleConnection(
  store: Store,
  userId: string,
  tokens: GoogleTokenResponse,
  calendarId = 'primary',
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const blob: StoredTokenBlob = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryMs: tokens.expiryMs,
    scope: tokens.scope,
  };
  await store.putUserSetting(userId, CALENDAR_OAUTH_KEY, {
    provider: 'google',
    status: 'connected',
    calendarId,
    scope: tokens.scope,
    connectedAt: nowIso,
    // The ONLY field holding secrets — AES-256-GCM ciphertext (SAU-261).
    enc: encrypt(JSON.stringify(blob)),
  });
}

/** Read + decrypt the stored connection, or null when none/undecryptable. */
export async function readGoogleConnection(store: Store, userId: string): Promise<GoogleCalendarConnection | null> {
  const rec = await store.getUserSetting(userId, CALENDAR_OAUTH_KEY);
  const value = rec?.value;
  if (!value || value.status !== 'connected' || typeof value.enc !== 'string') return null;
  let blob: StoredTokenBlob;
  try {
    blob = JSON.parse(decrypt(value.enc)) as StoredTokenBlob;
  } catch {
    return null; // tampered / key rotated — treat as not connected (fail soft)
  }
  return {
    calendarId: typeof value.calendarId === 'string' ? value.calendarId : 'primary',
    scope: typeof value.scope === 'string' ? value.scope : blob.scope,
    connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : '',
    tokens: {
      accessToken: blob.accessToken,
      refreshToken: blob.refreshToken,
      expiryMs: blob.expiryMs,
      scope: blob.scope,
    },
  };
}

export async function clearGoogleConnection(store: Store, userId: string): Promise<void> {
  await store.deleteUserSetting(userId, CALENDAR_OAUTH_KEY);
}

/**
 * Switch the target calendar of an existing connection in place (no re-consent):
 * bookings then read free/busy from and write events to `calendarId`. Returns false
 * when there's no connection to update. Used by the demo config panel (SAU-297).
 */
export async function setConnectionCalendarId(store: Store, userId: string, calendarId: string): Promise<boolean> {
  const conn = await readGoogleConnection(store, userId);
  if (!conn) return false;
  const cal = calendarId.trim() || 'primary';
  await saveGoogleConnection(store, userId, conn.tokens, cal, conn.connectedAt);
  return true;
}

/**
 * Return a valid access token for the connection, refreshing + persisting a new
 * one when the stored token is expired/near-expiry. Falls back to the stored token
 * when refresh isn't possible (no refresh token or OAuth app unconfigured) so a
 * transient gap degrades to a 401 from Google rather than a crash.
 */
export async function ensureFreshAccessToken(
  store: Store,
  userId: string,
  conn: GoogleCalendarConnection,
  nowMs: number = Date.now(),
): Promise<string> {
  const fresh = conn.tokens.expiryMs - REFRESH_SKEW_MS > nowMs;
  if (fresh) return conn.tokens.accessToken;

  const cfg = await resolveGoogleOAuthConfig(store, userId);
  if (!cfg || !conn.tokens.refreshToken) return conn.tokens.accessToken;

  const refreshed = await refreshAccessToken(cfg, conn.tokens.refreshToken, nowMs);
  await saveGoogleConnection(store, userId, refreshed, conn.calendarId, conn.connectedAt);
  return refreshed.accessToken;
}

export interface CalendarConnectionView {
  connected: boolean;
  calendarId: string | null;
  scope: string | null;
  connectedAt: string | null;
  /** Whether the platform OAuth app credentials are configured (gates the button). */
  oauthConfigured: boolean;
}

/** Connection state for the Settings → Integrations UI (no secrets returned). */
export async function getCalendarConnectionView(store: Store, userId: string): Promise<CalendarConnectionView> {
  const conn = await readGoogleConnection(store, userId);
  return {
    connected: Boolean(conn),
    calendarId: conn?.calendarId ?? null,
    scope: conn?.scope ?? null,
    connectedAt: conn?.connectedAt ?? null,
    oauthConfigured: (await resolveGoogleOAuthConfig(store, userId)) != null,
  };
}

// ── OAuth CSRF state (self-verifying, no server-side row) ─────────────────────--

/**
 * Sanitize a post-connect return path: only same-origin relative paths are allowed
 * (must start with a single "/", no scheme/host), so the encrypted state can't be
 * used as an open-redirect. Returns null for anything else.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p.startsWith('/') || p.startsWith('//')) return null;
  return p;
}

/** Mint an opaque `state` binding the flow to `userId` (+ calendarId + returnTo). */
export function buildOAuthState(userId: string, calendarId = 'primary', returnTo?: string | null): string {
  const ret = safeReturnTo(returnTo);
  return encrypt(
    JSON.stringify({ uid: userId, cal: calendarId, n: randomBytes(9).toString('base64'), ...(ret ? { ret } : {}) }),
  );
}

/** Verify the `state` returned by Google and recover the bound user + calendar. */
export function verifyOAuthState(
  state: string,
  expectedUserId: string,
): { calendarId: string; returnTo: string | null } | null {
  try {
    const parsed = JSON.parse(decrypt(state)) as { uid?: string; cal?: string; ret?: string };
    if (!parsed.uid || parsed.uid !== expectedUserId) return null;
    return {
      calendarId: typeof parsed.cal === 'string' && parsed.cal ? parsed.cal : 'primary',
      returnTo: safeReturnTo(parsed.ret),
    };
  } catch {
    return null;
  }
}
