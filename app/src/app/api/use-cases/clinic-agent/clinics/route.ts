/**
 * Clinic tenancy actions (SAU-301, Phase 2 · WS-B).
 *
 *   GET   → the switcher view (clinics the operator belongs to + which is active)
 *   POST  → provision a new clinic { name } (operator becomes owner; made active)
 *   PATCH → switch the active clinic { clinicId } (membership-gated)
 *
 * withActor keeps app.user_id / app.clinic_id bound so the RLS policies in
 * migration 0021 enforce that an operator only ever sees/creates/switches to
 * clinics they own.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { withActor } from '@/services/current-user';
import {
  getClinicSwitcherView,
  createClinicForUser,
  setActiveClinic,
  resolveActiveClinicId,
  TenancyError,
} from '@/services/clinic-tenancy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const view = await getClinicSwitcherView(getStore(), actor.userId, actor.clinicId ?? null);
    return NextResponse.json(view);
  });
}

export async function POST(req: NextRequest) {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name : '';
    try {
      const clinic = await createClinicForUser(getStore(), actor.userId, name);
      return NextResponse.json({ clinic }, { status: 201 });
    } catch (e) {
      if (e instanceof TenancyError) return NextResponse.json({ error: e.message }, { status: e.status });
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  });
}

export async function PATCH(req: NextRequest) {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const clinicId = typeof body?.clinicId === 'string' ? body.clinicId : '';
    try {
      const clinic = await setActiveClinic(getStore(), actor.userId, clinicId);
      const activeClinicId = await resolveActiveClinicId(getStore(), actor.userId, actor.clinicId ?? null);
      const view = await getClinicSwitcherView(getStore(), actor.userId, activeClinicId);
      return NextResponse.json({ clinic, ...view });
    } catch (e) {
      if (e instanceof TenancyError) return NextResponse.json({ error: e.message }, { status: e.status });
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  });
}
