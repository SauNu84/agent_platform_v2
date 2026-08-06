/**
 * GET / PUT /api/use-cases/call-center-agent/policy (SAU-521 · SAU-331 gate item 2).
 *
 * The means to set the per-lender collections policy WITHOUT A CODE DEPLOY — the half
 * that was missing on `main`. `allowedStates` existed in the engine but had no
 * persistence, no route, and no caller, so the state-licensing gate could never be
 * configured and therefore never fired.
 *
 * Tenant scoping is the same as the dashboard route: `withActor` puts app.clinic_id on
 * the connection so PgStore's reads/writes are RLS-scoped to the caller's lender under
 * the non-superuser app_rw role. A caller can only ever read or write THEIR OWN lender's
 * policy — there is no clinicId in the request body by design, so one lender cannot
 * name another lender's tenant and edit its licensing.
 *
 * The response includes the go-live preflight (AC 4a) so the settings UI can show
 * "this tenant cannot dial yet, and here is why" at the moment of editing, rather than
 * the operator discovering it later as a queue that dials nobody.
 */
import { NextResponse } from 'next/server';
import { getStore } from '@/db';
import { withActor } from '@/services/current-user';
import {
  loadTenantCollectionsConfig,
  saveTenantCollectionsPolicy,
  preflightCollectionsGoLive,
  CollectionsPolicyError,
} from '@/services/collections-policy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const clinicId = actor.clinicId ?? null;
    if (!clinicId) return NextResponse.json({ error: 'no active lender tenant selected' }, { status: 400 });

    const store = getStore();
    const policy = await loadTenantCollectionsConfig(store, clinicId);
    const preflight = await preflightCollectionsGoLive(store, clinicId);
    return NextResponse.json({ policy, preflight });
  });
}

export async function PUT(req: Request) {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const clinicId = actor.clinicId ?? null;
    if (!clinicId) return NextResponse.json({ error: 'no active lender tenant selected' }, { status: 400 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    const store = getStore();
    try {
      const saved = await saveTenantCollectionsPolicy(store, clinicId, body, actor.userId);
      // Re-run the preflight against what was actually STORED, not what was submitted —
      // an operator who clears the allow-list must be told immediately that they have
      // just stopped the queue.
      const preflight = await preflightCollectionsGoLive(store, clinicId);
      return NextResponse.json({ policy: saved, preflight });
    } catch (err) {
      if (err instanceof CollectionsPolicyError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  });
}
