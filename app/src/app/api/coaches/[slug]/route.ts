import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCoach, deleteCoach } from '@/services/coaches';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const coach = await getCoach(getStore(), params.slug);
  if (!coach) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ coach });
}

export async function DELETE(_req: NextRequest, { params }: { params: { slug: string } }) {
  const ok = await deleteCoach(getStore(), params.slug);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
