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
import { enterActor, runWithActor, type ActorContext } from '@/auth/actor';
import { resolveActiveClinicId } from '@/services/clinic-tenancy';

export type { Actor };

/** The RLS GUC slice carried for an actor (user + admin + clinic). */
function actorCtx(actor: Actor): ActorContext {
  return { userId: actor.userId, isAdmin: actor.isAdmin, clinicId: actor.clinicId };
}

/**
 * Multi-clinic switcher (SAU-301 WS-B): resolve the operator's *active* clinic so
 * it overrides their default app_user.clinic_id for RLS scoping. The resolution
 * reads (clinic_member / user_setting) themselves need app.user_id bound, so we
 * run them under the base context. Membership is re-checked inside
 * resolveActiveClinicId, so the result is always a clinic the user belongs to (or
 * their original clinic / null). Best-effort: any failure keeps the default.
 */
async function resolveActiveCtx(actor: Actor): Promise<ActorContext> {
  const base = actorCtx(actor);
  try {
    const clinicId = await runWithActor(base, () =>
      resolveActiveClinicId(getStore(), base.userId, base.clinicId ?? null),
    );
    // Keep the Actor's clinicId in lock-step with the bound GUC so handlers that
    // read actor.clinicId (e.g. the dashboard) see the *active* clinic, not just
    // the default app_user.clinic_id.
    actor.clinicId = clinicId;
    return { ...base, clinicId };
  } catch {
    return base;
  }
}

/**
 * Resolve the authenticated actor for the current request (or null). Side effect:
 * on success, binds the actor into ALS so the DB layer enforces RLS for the rest
 * of this request.
 *
 * NOTE (SAU-275): this uses `enterActor` (AsyncLocalStorage.enterWith), which is
 * the best-effort request-wide bind for Server Components. For ROUTE HANDLERS that
 * read/write PHI or own-private rows under the non-superuser `app_rw` role, prefer
 * {@link withActor} — `enterWith` is not reliably preserved across the framework's
 * async-context boundaries, whereas `runWithActor` (AsyncLocalStorage.run) scopes
 * the GUCs to the handler's own async subtree and always reaches PgStore.
 */
export async function getActor(): Promise<Actor | null> {
  const token = cookies().get(SESSION_COOKIE)?.value ?? null;
  const actor = await resolveActor(getStore(), token);
  if (!actor) return null;
  // Bind the base context first (so the active-clinic resolution reads succeed),
  // then re-bind with the resolved active clinic for the rest of the request.
  // Bind the base context first (so the active-clinic resolution reads succeed),
  // then re-bind with the resolved active clinic for the rest of the request.
  enterActor(actorCtx(actor));
  enterActor(await resolveActiveCtx(actor));
  return actor;
}

/**
 * Resolve the actor and run `fn` with the RLS context bound for the WHOLE callback
 * via `AsyncLocalStorage.run` (SAU-275). Unlike {@link getActor}'s `enterWith`,
 * this guarantees `app.user_id` / `app.is_admin` / `app.clinic_id` reach every
 * PgStore query inside `fn` — even under `app_rw` where RLS actually engages — so
 * own-private reads and session/PHI writes succeed instead of silently hitting the
 * fail-closed (empty-actor) policy path. `fn` receives the actor (or null when the
 * request is unauthenticated). Use this in route handlers that touch RLS-protected
 * data; pair with the 401/403 guards for authorization.
 */
export async function withActor<T>(fn: (actor: Actor | null) => Promise<T>): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value ?? null;
  const actor = await resolveActor(getStore(), token);
  if (!actor) return fn(null);
  const ctx = await resolveActiveCtx(actor);
  return runWithActor(ctx, () => fn(actor));
}

/** Page guard: resolve the actor or redirect to the login screen. */
export async function requirePageActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect('/login');
  return actor;
}
