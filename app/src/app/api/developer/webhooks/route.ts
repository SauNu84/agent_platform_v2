/**
 * POST /api/developer/webhooks — register a webhook endpoint (SAU-252).
 *
 * Body: { url: string, events: string[] }. Validates the URL + event ids, mints
 * a signing secret, and returns the created endpoint (secret included so the
 * user can copy it into their receiver).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getActor } from '@/services/current-user';
import { createWebhook, InvalidWebhookError } from '@/services/developer-tools';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  let body: { url?: string; events?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const wh = await createWebhook(
      getStore(),
      actor.userId,
      String(body.url ?? ''),
      Array.isArray(body.events) ? body.events.map(String) : [],
    );
    return NextResponse.json(wh, { status: 201 });
  } catch (e) {
    if (e instanceof InvalidWebhookError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
