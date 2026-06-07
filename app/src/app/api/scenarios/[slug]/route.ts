/**
 * /api/scenarios/[slug] — get (GET), edit (PUT), delete (DELETE) one scenario.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getScenario, updateScenario, deleteScenario, ScenarioCompileError } from '@/services/scenarios';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const scenario = await getScenario(getStore(), params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ scenario });
}

export async function PUT(req: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const body = await req.json();
    const scenario = await updateScenario(getStore(), params.slug, body);
    if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ scenario });
  } catch (e) {
    if (e instanceof ScenarioCompileError) return NextResponse.json({ error: e.message, issues: e.issues }, { status: 422 });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { slug: string } }) {
  const ok = await deleteScenario(getStore(), params.slug);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
