/**
 * POST /api/authoring/parse-rubric — Rubric "Processed" tab (SAU-238).
 *
 * Turns the free-text rubric the author wrote in the Studio "Edit" tab into the
 * structured `{ topic, weight, note }[]` the LLM judge scores against. It is the
 * same `Author` seam as generation: the live `AnthropicAuthor` parses with Claude
 * when a key is configured, otherwise the deterministic `TemplateAuthor` runs the
 * parse offline with no spend. The result is a DRAFT — the author reviews/edits
 * it in the Processed tab before it is saved with the scenario.
 *
 * Body: { text: string }   →  { rubric: RubricItem[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthor } from '@/authoring/author';
import { actorWithCapability } from '@/auth/api-guard';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const gate = await actorWithCapability('author_content');
  if ('response' in gate) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: '`text` is required' }, { status: 400 });
  }

  try {
    const rubric = await getAuthor().parseRubric(text);
    return NextResponse.json({ rubric, author: getAuthor().name });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
