/**
 * Authentication provider seam.
 *
 * The issue (SAU-229) mandates "reuse the org's auth identity — do not build a
 * second identity system" and "keep the provider behind a seam". This repo has
 * no pre-existing identity system to reuse, so the MVP ships a local
 * email+password provider — but behind this interface, so an org SSO/OIDC
 * provider can replace it later with no changes to the session/RBAC layers.
 */
import type { Store } from '@/db/store';
import { verifyPassword } from './password';

export interface AuthProvider {
  /** Verify credentials; resolve to the app_user id on success, else null. */
  verifyCredentials(email: string, password: string): Promise<string | null>;
}

/** Default MVP provider: local credentials backed by the `app_user` table. */
export class LocalPasswordProvider implements AuthProvider {
  constructor(private store: Store) {}

  async verifyCredentials(email: string, password: string): Promise<string | null> {
    const user = await this.store.getUserByEmail(email.trim().toLowerCase());
    if (!user) return null;
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? user.id : null;
  }
}

/**
 * Resolve the active auth provider. Swap point for org SSO: branch on an env
 * flag (e.g. AUTH_PROVIDER=oidc) and return a different implementation. MVP
 * always returns the local-password provider.
 */
export function getAuthProvider(store: Store): AuthProvider {
  return new LocalPasswordProvider(store);
}
