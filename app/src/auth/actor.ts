/**
 * Request-scoped actor context (AsyncLocalStorage).
 *
 * The Postgres RLS policies (migration 0005) read two GUCs — `app.user_id` and
 * `app.is_admin`. Rather than thread a user argument through every Store method,
 * the auth layer establishes the acting user once per request and PgStore reads
 * it from here, setting the GUCs inside each transaction (mirroring the
 * coach_memory `withUser` pattern). No context set (anonymous request, seed
 * tooling without a wrapper) → public-only reads, writes that require ownership
 * are rejected by the policy.
 *
 * This is a pure, dependency-free module so both the auth layer and the DB layer
 * can import it without a cycle.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The minimal slice of identity the DB needs to enforce RLS. */
export interface ActorContext {
  userId: string;
  /** holds platform_admin → full RLS bypass (set app.is_admin = 'on') */
  isAdmin: boolean;
}

const storage = new AsyncLocalStorage<ActorContext>();

/** Run `fn` with the given actor bound for the duration of its async execution. */
export function runWithActor<T>(ctx: ActorContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Bind the actor for the remainder of the current async execution (used by the
 * per-request resolver in server components / route handlers, where there is no
 * single callback to wrap). Each request runs in its own async context, so this
 * does not leak across requests.
 */
export function enterActor(ctx: ActorContext): void {
  storage.enterWith(ctx);
}

/** The current actor context, or undefined for an anonymous/unbound execution. */
export function getActorContext(): ActorContext | undefined {
  return storage.getStore();
}
