/**
 * Session + actor resolution (pure, store-driven — no next/headers here so it is
 * unit-testable). Cookie I/O and the per-request ALS binding live in
 * current-user.ts; this module owns token lifecycle and turning a token into a
 * fully-resolved Actor (identity + role + capabilities).
 */
import { randomBytes } from 'node:crypto';
import type { Store } from '@/db/store';
import { getAuthProvider } from './provider';
import { type Capability, isAdminCaps, DEFAULT_ROLE } from './rbac';
import { SESSION_COOKIE, SESSION_TTL_MS } from './constants';

export { SESSION_COOKIE, SESSION_TTL_MS };

/** A fully-resolved acting user: identity + role + capability bundle. */
export interface Actor {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  capabilities: Capability[];
  /** holds platform_admin → unrestricted (admin) */
  isAdmin: boolean;
  /** the user's clinic/org (SAU-275); null for platform/consumer users. */
  clinicId: string | null;
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Verify credentials via the provider seam and, on success, mint a server-side
 * session. Returns the token (cookie value) + expiry, or null on bad creds.
 */
export async function login(
  store: Store,
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: string } | null> {
  const userId = await getAuthProvider(store).verifyCredentials(email, password);
  if (!userId) return null;
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await store.createAuthSession(token, userId, expiresAt);
  return { token, expiresAt };
}

/** Revoke a session token (logout). Idempotent. */
export async function logout(store: Store, token: string): Promise<void> {
  await store.deleteAuthSession(token);
}

/**
 * Resolve a session token to a full Actor, or null if the token is unknown or
 * expired (expired tokens are cleaned up opportunistically). Role defaults to
 * `user` if a user somehow has no role row, and capabilities come from the
 * role_capability config table.
 */
export async function resolveActor(store: Store, token: string | undefined | null): Promise<Actor | null> {
  if (!token) return null;
  const sess = await store.getAuthSession(token);
  if (!sess) return null;
  if (Date.parse(sess.expiresAt) <= Date.now()) {
    await store.deleteAuthSession(token);
    return null;
  }
  const user = await store.getUserById(sess.userId);
  if (!user) return null;
  const role = (await store.getUserRole(user.id)) ?? DEFAULT_ROLE;
  const capabilities = (await store.getRoleCapabilities(role)) as Capability[];
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role,
    capabilities,
    isAdmin: isAdminCaps(capabilities),
    clinicId: user.clinicId ?? null,
  };
}
