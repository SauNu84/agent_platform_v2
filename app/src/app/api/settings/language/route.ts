/**
 * /api/settings/language — set the preferred language for AI conversation (SAU-253).
 * Personal preference: any authenticated actor; own-scoped by userId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorOr401 } from '@/auth/api-guard';
import { setPreferredLanguage, SettingsError } from '@/services/settings';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest) {
  const gate = await actorOr401();
  if ('response' in gate) return gate.response;
  try {
    const body = await req.json().catch(() => ({}));
    const lang = await setPreferredLanguage(getStore(), gate.actor.userId, String(body?.lang ?? ''));
    return NextResponse.json({ lang });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
