/**
 * /api/use-cases/clinic-agent/config (SAU-300, Phase 2 · WS-A) — save (PUT) or
 * clear (DELETE) the no-code clinic definition: profile + hours, doctors,
 * services, insurance, booking rules and the agent greeting. Own-scoped by userId
 * and stored in the RLS-isolated user_setting table (services/clinic-config); the
 * booking tools read this config at call time and enforce the rules in the tool.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorOr401 } from '@/auth/api-guard';
import { saveClinicConfig, clearClinicConfig, ClinicConfigError } from '@/services/clinic-config';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    const config = await saveClinicConfig(getStore(), gate.actor.userId, body);
    return NextResponse.json({ config });
  } catch (e) {
    if (e instanceof ClinicConfigError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE() {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  const config = await clearClinicConfig(getStore(), gate.actor.userId);
  return NextResponse.json({ config });
}
