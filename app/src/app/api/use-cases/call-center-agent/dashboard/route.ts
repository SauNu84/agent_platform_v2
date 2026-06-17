/**
 * GET /api/use-cases/call-center-agent/dashboard (SAU-335, WS-4).
 *
 * Per-lender collections ops metrics for the ACTIVE lender (cadence + next-eligible
 * dial, suppression / opt-out list, compliance-block counts, and the read-only
 * guardrail-10 audit trail) plus the lender switcher view. Uses withActor so
 * app.clinic_id reliably reaches PgStore under the non-superuser app_rw role
 * (SAU-275) — every read is then RLS-scoped to the caller's lender with no
 * cross-tenant leakage. Synthetic debtors only.
 */
import { NextResponse } from 'next/server';
import { getStore } from '@/db';
import { withActor } from '@/services/current-user';
import { getCollectionsDashboard } from '@/services/collections-dashboard';
import { getClinicSwitcherView } from '@/services/clinic-tenancy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const store = getStore();
    const activeClinicId = actor.clinicId ?? null;
    const switcher = await getClinicSwitcherView(store, actor.userId, activeClinicId);
    const metrics = activeClinicId
      ? await getCollectionsDashboard(store, activeClinicId, Date.now())
      : null;
    return NextResponse.json({ switcher, metrics });
  });
}
