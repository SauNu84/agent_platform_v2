/**
 * POST /api/scenarios/[slug]/share — mint (or return the existing) shareable
 * short link for a scenario (SAU-225). Idempotent: re-posting returns the SAME
 * code. Private scenarios are not shareable → 403 with a note.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { shareScenario, ShareNotAllowedError } from '@/services/share';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const result = await shareScenario(getStore(), params.slug);
    if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ShareNotAllowedError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
