/**
 * PATCH /api/use-cases/clinic-agent/clinics/telephony (SAU-525) — bind the dialed
 * number and/or engine grade to a clinic tenant.
 *
 *   { clinicId, phoneNumber?: E.164 | null, voiceEngine?: 'standard' | 'premium' | null }
 *
 * Membership-gated; the phone-number binding is platform-admin-only (numbers are
 * provisioned by the platform, so which tenant answers one is not self-service).
 * withActor keeps app.user_id bound so the 0021 `clinic_member_update` RLS policy
 * re-checks membership on the UPDATE itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { withActor } from '@/services/current-user';
import { setClinicTelephony, TenancyError } from '@/services/clinic-tenancy';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest) {
  return withActor(async (actor) => {
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const clinicId = typeof body?.clinicId === 'string' ? body.clinicId : '';
    if (!clinicId) return NextResponse.json({ error: 'clinicId is required' }, { status: 400 });
    const input = {
      phoneNumber: 'phoneNumber' in body ? (body.phoneNumber as string | null) : undefined,
      voiceEngine: 'voiceEngine' in body ? (body.voiceEngine as string | null) : undefined,
    };
    try {
      const clinic = await setClinicTelephony(getStore(), { userId: actor.userId, isAdmin: actor.isAdmin }, clinicId, input);
      return NextResponse.json({
        clinic: { id: clinic.id, slug: clinic.slug, name: clinic.name, phoneNumber: clinic.phoneNumber, voiceEngine: clinic.voiceEngine },
      });
    } catch (e) {
      if (e instanceof TenancyError) return NextResponse.json({ error: e.message }, { status: e.status });
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  });
}
