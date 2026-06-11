/**
 * POST /api/authoring/edit — AI Studio conversational editing (SAU-244).
 *
 * Body: { draft: ScenarioEditFields, instruction: string, effort?: 'flash'|'deep' }
 *
 * Takes the CURRENT draft field set + a natural-language instruction and returns
 * a patched field set + a one-line "what changed" summary. Like /generate, it
 * NEVER writes the DB — the copilot proposes a patch the author reviews in the
 * 4-tab form. A patch that fails the Slice-1 compiler comes back with `ok: false`
 * and actionable `errors` (HTTP 422); the proposed fields are still returned.
 */
import { NextRequest, NextResponse } from 'next/server';
import { editScenarioDraft } from '@/authoring/pipeline';
import type { ScenarioEditFields } from '@/authoring/author';
import type { RubricItem } from '@/domain/scenario';
import { actorWithCapability } from '@/auth/api-guard';

export const dynamic = 'force-dynamic';

/** Coerce an untrusted body into a complete, well-typed field set. */
function coerceFields(raw: unknown): ScenarioEditFields {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const rubric: RubricItem[] = Array.isArray(o.rubric)
    ? o.rubric
        .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : null))
        .filter((e): e is Record<string, unknown> => !!e && typeof e.topic === 'string')
        .map((e) => ({
          topic: (e.topic as string),
          weight: Number.isFinite(Number(e.weight)) ? Number(e.weight) : 0,
          ...(typeof e.note === 'string' && e.note.trim() ? { note: e.note.trim() } : {}),
        }))
    : [];
  return {
    name: str(o.name),
    description: str(o.description),
    userInstructions: str(o.userInstructions),
    aiDescription: str(o.aiDescription),
    persona: str(o.persona),
    rubric,
  };
}

export async function POST(req: NextRequest) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction) {
    return NextResponse.json({ error: '`instruction` is required' }, { status: 400 });
  }
  const fields = coerceFields(body.draft);
  const effort = body.effort === 'deep' ? 'deep' : body.effort === 'flash' ? 'flash' : undefined;

  try {
    const draft = await editScenarioDraft(fields, instruction, { effort });
    // A patch that didn't compile is a 422 (the proposed fields ride along so the
    // author sees the actionable errors), otherwise 200.
    return NextResponse.json({ draft }, { status: draft.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
