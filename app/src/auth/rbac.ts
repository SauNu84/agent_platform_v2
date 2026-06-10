/**
 * Capability-based RBAC vocabulary (ADR-007 rev 3).
 *
 * The atomic *capabilities* are the unit of authorization — a role is just a
 * named bundle of them, resolved from the `role_capability` table (config, not
 * code). This module holds the capability/role vocabulary + pure helpers; the
 * source of truth for which capabilities a role actually has lives in the DB so
 * roles can be edited/split without a code change.
 *
 * The fallback bundles below mirror the migration seed (0005). They are used by
 * the in-memory store (tests/dev) and as a defensive default if the DB has no
 * rows for a role yet — production reads role_capability.
 */

export const CAPABILITIES = [
  'practice',
  'author_content',
  'assign_to_users',
  'view_identified_results',
  'manage_org_members',
  'manage_billing',
  'platform_admin',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The roles defined today. MVP UI gates on `user`/`admin`; `operator` is B2B. */
export const ROLES = ['user', 'admin', 'operator'] as const;
export type Role = (typeof ROLES)[number];

export const DEFAULT_ROLE: Role = 'user';

/**
 * Capability bundles per role — MUST stay in sync with migration 0005's
 * role_capability seed. The DB is authoritative at runtime; this is the
 * in-memory/dev mirror and the safety net.
 */
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  user: ['practice', 'author_content'],
  admin: [...CAPABILITIES],
  operator: ['practice', 'author_content', 'assign_to_users', 'view_identified_results'],
};

/** True if the capability set grants `cap`. */
export function hasCapability(caps: readonly string[], cap: Capability): boolean {
  return caps.includes(cap);
}

/** A holder of platform_admin is the unrestricted admin (full RLS bypass). */
export function isAdminCaps(caps: readonly string[]): boolean {
  return caps.includes('platform_admin');
}

/** Resolve a role name to its capability bundle (dev/in-memory fallback). */
export function capabilitiesForRole(role: string): Capability[] {
  return ROLE_CAPABILITIES[(role as Role)] ?? [];
}
