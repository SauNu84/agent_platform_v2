/**
 * GET /api/use-cases/clinic-agent/dashboard (SAU-301, Phase 2 · WS-B).
 *
 * Per-clinic ops metrics for the ACTIVE clinic (booked / no_slot / escalated,
 * booking accuracy, escalation + after-hours capture, PHI-safety) plus the clinic
 * switcher view. Uses withActor so app.clinic_id reliably reaches PgStore under the
 * non-superuser app_rw role (SAU-275) — the metrics are then RLS-scoped to the
 * caller's clinic with no cross-clinic leakage.
 */
import { NextResponse } from 'next/server';
import { getStore } from '@/db';
import { withActor } from '@/services/current-user';
import { getClinicDashboard } from '@/services/clinic-dashboard';
import { getClinicSwitcherView } from '@/services/clinic-tenancy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const store = getStore();
    const activeClinicId = actor.clinicId ?? null;
    const switcher = await getClinicSwitcherView(store, actor.userId, activeClinicId);
    const metrics = activeClinicId ? await getClinicDashboard(store, activeClinicId) : null;
    return NextResponse.json({ switcher, metrics });
  });
}
