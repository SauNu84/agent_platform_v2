/**
 * Current-user resolution (Slice 5 — real auth, replaces the DEMO_USER_ID stub).
 *
 * Reads the session cookie, resolves it to a full Actor (identity + role +
 * capabilities) via the store, and binds the actor into the request-scoped ALS
 * context so PgStore applies the RLS GUCs (app.user_id / app.is_admin) to every
 * subsequent query in this request. Server components and route handlers both
 * call getActor(); protected pages use requirePageActor() to redirect to /login.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getStore } from '@/db';
import { resolveActor, type Actor } from '@/auth/session';
import { SESSION_COOKIE } from '@/auth/constants';
import { enterActor } from '@/auth/actor';

export type { Actor };

/**
 * Resolve the authenticated actor for the current request (or null). Side effect:
 * on success, binds the actor into ALS so the DB layer enforces RLS for the rest
 * of this request.
 */
export async function getActor(): Promise<Actor | null> {
  const token = cookies().get(SESSION_COOKIE)?.value ?? null;
  const actor = await resolveActor(getStore(), token);
  if (actor) enterActor({ userId: actor.userId, isAdmin: actor.isAdmin });
  return actor;
}

/** Page guard: resolve the actor or redirect to the login screen. */
export async function requirePageActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  return actor;
}
