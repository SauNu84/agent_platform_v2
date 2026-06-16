/**
 * /api/use-cases/clinic-agent/phone (SAU-297) — set (PUT) or clear (DELETE) the
 * AI Clinic Agent demo phone numbers: the agent number patients call and an
 * optional clinic handoff number. Own-scoped by userId; numbers are not secrets,
 * so they're stored in the RLS-protected user_setting table (services/clinic-phone).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorOr401 } from '@/auth/api-guard';
import { saveClinicPhoneConfig, clearClinicPhoneConfig, ClinicPhoneError } from '@/services/clinic-phone';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const phone = await saveClinicPhoneConfig(getStore(), gate.actor.userId, {
      agentNumber: body.agentNumber,
      clinicHandoffNumber: body.clinicHandoffNumber,
    });
    return NextResponse.json({ phone });
  } catch (e) {
    if (e instanceof ClinicPhoneError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE() {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  const phone = await clearClinicPhoneConfig(getStore(), gate.actor.userId);
  return NextResponse.json({ phone });
}
