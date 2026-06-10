/**
 * /api/scenarios/[slug]/chat — one text chat turn with the scenario persona (SAU-224).
 *
 * The scenario detail page replaced the live/simulated voice demo with a text Chat
 * (board direction, 2026-06-10). POST a learner `message` (+ the conversation
 * `history` and an optional `sessionId` to continue one conversation); the persona
 * replies via the `ChatResponder` seam (live Claude when keyed, deterministic mock
 * otherwise — fails soft exactly like the Join mock). Each turn persists the
 * conversation as a `session` (status `completed`) so History / Analytics / the
 * Sessions tab keep working. The underlying voice-session code is untouched
 * (SAU-193/SAU-208) — this is a separate text surface.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getScenario } from '@/services/scenarios';
import { runChatTurn } from '@/chat/chat-session';
import { currentUserId } from '@/services/current-user';
import type { ChatTurn } from '@/chat/responder';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { slug: string } }) {
  const store = getStore();
  const scenario = await getScenario(store, params.slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: { message?: string; history?: ChatTurn[]; sessionId?: string; userId?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body handled below */
  }

  const message = typeof body.message === 'string' ? body.message : '';
  if (!message.trim()) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  // Only keep well-formed prior turns from the client (it is the live source of truth).
  const history: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter((t): t is ChatTurn => !!t && (t.role === 'user' || t.role === 'agent') && typeof t.text === 'string')
        .map((t) => ({ role: t.role, text: t.text }))
    : [];

  const userId = body.userId ?? currentUserId(req);

  try {
    const result = await runChatTurn({ store, scenario, message, history, sessionId: body.sessionId, userId });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
