/**
 * google-oauth-config.ts (SAU-297 follow-up) — let an operator provide the Google
 * OAuth APP credentials (client id + secret) from the UI instead of editing
 * `.env`, mirroring the Scenario AI Model keys pattern (SAU-259): the secret is
 * AES-256-GCM encrypted at rest (SAU-261), read ONLY server-side, and never echoed
 * back (the view returns a masked client id + a "secret configured" flag).
 *
 * Resolution order for the effective OAuth app config: the env vars
 * (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`) ALWAYS win — same as the
 * model-key precedence — else the per-user stored credentials. Absent both ⇒ the
 * connect flow stays "not configured" and booking falls back to the sandbox/mock.
 *
 * Grain: per-user (the clinic operator who runs the demo connects their own Google
 * Cloud OAuth app). RLS-isolated in `user_setting`. A true platform-global slot is
 * a later refinement; for the synthetic demo the operator is the clinic.
 */
import type { Store } from '@/db/store';
import { encrypt, tryDecryptIfEncrypted } from '@/lib/crypto';
import { readGoogleOAuthConfig, resolveRedirectUri, type GoogleOAuthConfig } from './google-oauth';

/** user_setting key for the stored Google OAuth app credentials. */
export const GOOGLE_OAUTH_APP_KEY = 'google_oauth_app';

export class GoogleOAuthAppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'GoogleOAuthAppError';
    this.status = status;
  }
}

/** Client-safe view for the config panel (never the raw secret). */
export interface GoogleOAuthAppView {
  /** True when env OR stored credentials are present (gates the Connect button). */
  configured: boolean;
  /** True when an env var supplies the config (it takes precedence over stored). */
  envProvisioned: boolean;
  /** Masked tail of the stored client id (…last8), or null. */
  clientIdMasked: string | null;
  /** True when a client secret is stored (we never reveal it). */
  secretConfigured: boolean;
  /** The redirect URI the operator must register in their Google Cloud console. */
  redirectUri: string;
  updatedAt: string | null;
}

function maskClientId(clientId: string): string {
  const tail = clientId.length > 8 ? clientId.slice(-8) : clientId;
  return `…${tail}`;
}

/**
 * Read + decrypt the stored OAuth app credentials, or null when none/invalid.
 * Fail-soft: an undecryptable secret (SETTINGS_ENCRYPTION_KEY rotated/mismatched or
 * a tampered row) reads as null — the connect flow degrades to "not configured"
 * rather than throwing and crashing the settings page.
 */
export async function readStoredGoogleOAuthConfig(store: Store, userId: string): Promise<GoogleOAuthConfig | null> {
  if (!userId) return null;
  const rec = await store.getUserSetting(userId, GOOGLE_OAUTH_APP_KEY);
  const value = rec?.value;
  const clientId = typeof value?.clientId === 'string' ? value.clientId.trim() : '';
  const rawSecret = typeof value?.clientSecret === 'string' ? value.clientSecret : '';
  if (!clientId || !rawSecret) return null;
  const clientSecret = tryDecryptIfEncrypted(rawSecret);
  if (!clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The effective OAuth app config: env ALWAYS wins (operator/board can still pin it
 * via env), else the per-user stored credentials. Used by the connect/callback
 * routes and the connection-state view.
 */
export async function resolveGoogleOAuthConfig(store: Store, userId: string | null): Promise<GoogleOAuthConfig | null> {
  const env = readGoogleOAuthConfig();
  if (env) return env;
  if (!userId) return null;
  return readStoredGoogleOAuthConfig(store, userId);
}

/** Build the panel view (configured flags + masked client id + redirect URI). */
export async function getGoogleOAuthAppView(
  store: Store,
  userId: string,
  origin: string,
): Promise<GoogleOAuthAppView> {
  const env = readGoogleOAuthConfig();
  const rec = await store.getUserSetting(userId, GOOGLE_OAUTH_APP_KEY);
  const stored = await readStoredGoogleOAuthConfig(store, userId);
  const effectiveClientId = env?.clientId ?? stored?.clientId ?? null;
  return {
    configured: Boolean(env || stored),
    envProvisioned: Boolean(env),
    clientIdMasked: effectiveClientId ? maskClientId(effectiveClientId) : null,
    secretConfigured: Boolean(env || stored),
    redirectUri: resolveRedirectUri(origin),
    updatedAt: rec?.updatedAt ?? null,
  };
}

/** Validate + persist the OAuth app credentials (secret encrypted at rest). */
export async function saveGoogleOAuthApp(
  store: Store,
  userId: string,
  origin: string,
  rawClientId: unknown,
  rawClientSecret: unknown,
): Promise<GoogleOAuthAppView> {
  const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
  const clientSecret = typeof rawClientSecret === 'string' ? rawClientSecret.trim() : '';
  if (!clientId) throw new GoogleOAuthAppError('Client ID is required.');
  // Google web-app client ids end with .apps.googleusercontent.com — a light sanity
  // check so an obviously wrong value is caught before the consent round-trip.
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new GoogleOAuthAppError('That does not look like a Google OAuth client ID (…apps.googleusercontent.com).');
  }
  if (clientSecret.length < 10) throw new GoogleOAuthAppError('Client secret looks too short.');

  await store.putUserSetting(userId, GOOGLE_OAUTH_APP_KEY, {
    status: 'configured',
    clientId, // client id is not a secret (it ships in the consent URL); kept plaintext
    clientSecret: encrypt(clientSecret), // the secret is encrypted at rest (SAU-261)
  });
  return getGoogleOAuthAppView(store, userId, origin);
}

/** Remove the stored OAuth app credentials (reverts to env / not-configured). */
export async function clearGoogleOAuthApp(store: Store, userId: string, origin: string): Promise<GoogleOAuthAppView> {
  await store.deleteUserSetting(userId, GOOGLE_OAUTH_APP_KEY);
  return getGoogleOAuthAppView(store, userId, origin);
}
