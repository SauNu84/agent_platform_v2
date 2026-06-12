/**
 * POST /api/developer/keys — mint a new API key (SAU-252).
 *
 * Body: { name?: string }. Returns the created key record PLUS the plaintext
 * secret, which is shown to the user exactly once and never retrievable again.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getActor } from '@/services/current-user';
import { createApiKey } from '@/services/developer-tools';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  let body: { name?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — name defaults */
  }

  const { record, plaintext } = await createApiKey(getStore(), actor.userId, String(body.name ?? ''));
  return NextResponse.json(
    {
      id: record.id,
      name: record.name,
      keyPrefix: record.keyPrefix,
      createdAt: record.createdAt,
      // Shown once; the server keeps only the hash.
      plaintext,
    },
    { status: 201 },
  );
}
