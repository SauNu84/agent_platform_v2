/**
 * Chat session service — the platform's single entry point to a text chat turn
 * with a scenario persona (SAU-224).
 *
 * Each turn: generate the persona reply via the `ChatResponder` seam, then persist
 * the conversation-so-far as a `session` (status `completed`) so History /
 * Analytics / the Sessions tab keep working unchanged — the SAME projections the
 * voice path feeds. The first turn creates the session row; later turns extend the
 * same row (passed back as `sessionId`) so one conversation = one session.
 *
 * Text chat is intentionally NOT metered into `voice_usage`: it consumes no voice
 * minutes, so it neither records usage nor counts against the voice-minute cap.
 * It still appears in Creator Analytics by session count (which aggregates the
 * `session` table directly).
 */
import type { ScenarioRecord } from '@/domain/scenario';
import type { Store, SessionTranscript } from '@/db/store';
import { ChatResponder, ChatTurn, chatSystemPrompt, getResponder } from './responder';

export interface RunChatTurnOptions {
  store: Store;
  scenario: ScenarioRecord;
  /** the new learner message */
  message: string;
  /** prior turns of this conversation (the client is the live source of truth) */
  history?: ChatTurn[];
  /** extend this existing session row instead of creating a new one */
  sessionId?: string;
  userId?: string | null;
  /** override the responder (tests inject a scripted/mock one); defaults to getResponder() */
  responder?: ChatResponder;
  /** monotonic timestamp for the turn (ms); defaults to Date.now() */
  now?: number;
}

export interface ChatTurnResult {
  sessionId: string;
  reply: string;
  vendor: string;
  /** the full transcript turns after this turn (authoritative for the client) */
  turns: Array<{ role: 'user' | 'agent'; text: string; at: number }>;
}

export async function runChatTurn(opts: RunChatTurnOptions): Promise<ChatTurnResult> {
  const { store, scenario, message, userId = null } = opts;
  const responder = opts.responder ?? getResponder();
  const history = opts.history ?? [];
  const now = opts.now ?? Date.now();

  const trimmed = message.trim();
  if (!trimmed) throw new Error('message is required');

  const system = chatSystemPrompt(scenario.aiInstructions);
  const reply = await responder.reply({ system, history, message: trimmed });

  // Full transcript = prior history + this user turn + this agent reply.
  const turns: ChatTurnResult['turns'] = [
    ...history.map((t) => ({ role: t.role, text: t.text, at: now })),
    { role: 'user', text: trimmed, at: now },
    { role: 'agent', text: reply, at: now },
  ];
  const transcript: SessionTranscript = { turns, toolCalls: [] };
  const vendor = `chat:${responder.name}`;

  // First turn creates the row; later turns extend the same one.
  let sessionId = opts.sessionId ?? null;
  if (sessionId) {
    const existing = await store.getSession(sessionId);
    if (!existing || existing.scenarioId !== scenario.id) sessionId = null;
  }
  if (!sessionId) {
    const row = await store.createSession({ scenarioId: scenario.id, userId, vendor });
    sessionId = row.id;
  }

  // Persist the two NEW turns as semantic events (Sessions tab + Analyst parity
  // with the voice path), then upsert the full transcript on the row.
  await store.appendSessionEvent({ sessionId, ts: now, type: 'user.transcript', payload: { text: trimmed, final: true } });
  await store.appendSessionEvent({ sessionId, ts: now, type: 'agent.transcript', payload: { text: reply, final: true } });
  await store.completeSession(sessionId, {
    status: 'completed',
    endedAt: now,
    transcript,
  });

  return { sessionId, reply, vendor, turns };
}
