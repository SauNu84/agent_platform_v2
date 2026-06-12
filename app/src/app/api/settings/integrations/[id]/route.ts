/**
 * /api/settings/integrations/[id] — configure (PUT) or disconnect (DELETE) an
 * integration: phone (SIP trunk), calendar, or MCP tools (SAU-253). Persists the
 * connection config + a 'configured' status; live execution of the integration
 * is a follow-up. Own-scoped by userId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorOr401 } from '@/auth/api-guard';
import { configureIntegration, disconnectIntegration, SettingsError } from '@/services/settings';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    const config = (body?.config ?? {}) as Record<string, unknown>;
    const integration = await configureIntegration(getStore(), gate.actor.userId, params.id, config);
    return NextResponse.json({ integration });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  try {
    const integration = await disconnectIntegration(getStore(), gate.actor.userId, params.id);
    return NextResponse.json({ integration });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
