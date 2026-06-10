/**
 * Authorization guards — the API/route-layer half of the two-layer enforcement
 * (ADR-007). The DB-layer half is RLS (migration 0005); these guards give fast,
 * explicit 401/403s and cover capability checks that RLS alone can't express
 * (e.g. "may call the admin user-management endpoint").
 */
import { type Capability, hasCapability } from './rbac';
import type { Actor } from './session';

/** No authenticated actor → 401. */
export class UnauthenticatedError extends Error {
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** Authenticated but lacks the capability / ownership → 403. */
export class ForbiddenError extends Error {
  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Assert there is an authenticated actor, returning it narrowed to non-null. */
export function requireActor(actor: Actor | null | undefined): Actor {
  if (!actor) throw new UnauthenticatedError();
  return actor;
}

/** Assert the actor holds `cap` (admin holds all). */
export function requireCapability(actor: Actor | null | undefined, cap: Capability): Actor {
  const a = requireActor(actor);
  if (a.isAdmin || hasCapability(a.capabilities, cap)) return a;
  throw new ForbiddenError(`missing capability: ${cap}`);
}

/**
 * Assert the actor owns the resource (or is admin). `ownerUserId` null means
 * platform/seeded content — only an admin may mutate it.
 */
export function requireOwnership(actor: Actor | null | undefined, ownerUserId: string | null): Actor {
  const a = requireActor(actor);
  if (a.isAdmin) return a;
  if (ownerUserId && ownerUserId === a.userId) return a;
  throw new ForbiddenError('not the owner of this resource');
}

/** Map a guard error to an HTTP status (401/403); rethrow anything else. */
export function authErrorStatus(e: unknown): 401 | 403 | null {
  if (e instanceof UnauthenticatedError) return 401;
  if (e instanceof ForbiddenError) return 403;
  return null;
}
