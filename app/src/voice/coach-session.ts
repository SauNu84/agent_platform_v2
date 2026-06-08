/**
 * Coach session orchestration (Slice 3) — the memory loop that makes a Coach more
 * than a Scenario (ADR-001 + ADR-004):
 *
 *   1. RETRIEVE the most relevant memories for (coach, user) and inject them into
 *      the agent's instructions ("what you remember about this learner").
 *   2. RUN the session through the same realtime seam as a Scenario, tagged with
 *      coach_id (server-driven with the mock/OpenAI, or client-driven transcript).
 *   3. WRITE derived memories from the transcript — gated on persistent-memory
 *      consent (ADR-004). Audit every retrieve/write (counts only, no PII).
 *
 * So session N+1 demonstrably picks up what session N learned.
 */
import { runVoiceSession, persistClientSession, type Vendor, type VoiceSessionResult } from './session-service';
import type { Transcript } from './realtime-interface';
import type { CoachMemoryRecord, Store } from '@/db/store';
import type { CoachRecord } from '@/domain/coach';
import type { ScenarioRecord } from '@/domain/scenario';
import { buildMemoryBlock, deriveMemories, embed, expiresAtFor, rankMemories } from '@/coach/memory';
import { getCoachConsent } from '@/coach/consent';

export interface CoachSessionResult extends VoiceSessionResult {
  /** memories retrieved + injected into this session's agent instructions */
  injectedMemories: CoachMemoryRecord[];
  /** the instructions actually sent to the agent (scenario persona + memory block) */
  injectedInstructions: string;
  /** how many derived memories were written from this session's transcript */
  wroteMemories: number;
  /** why memory wasn't written (consent/anonymous), or null if it was */
  memorySkippedReason: string | null;
}

export interface RunCoachSessionOptions {
  store: Store;
  coach: CoachRecord;
  scenario: ScenarioRecord;        // resolved from coach.scenarioId by the caller
  vendor: Vendor;
  userId: string | null;
  /** client-driven path: a transcript the browser already produced */
  transcript?: Transcript;
  /** retrieval "now" (ms) for deterministic tests; defaults to wall clock */
  nowMs?: number;
  /** how many memories to inject (token budget); default from rankMemories */
  k?: number;
}

export async function runCoachSession(opts: RunCoachSessionOptions): Promise<CoachSessionResult> {
  const { store, coach, scenario, vendor, userId, transcript, nowMs, k } = opts;

  // 1) Retrieve + inject memory (only for an identified user).
  let injectedMemories: CoachMemoryRecord[] = [];
  if (userId) {
    const candidates = await store.listCoachMemory(coach.id, userId);
    injectedMemories = rankMemories(candidates, { k, nowMs });
    if (injectedMemories.length) {
      await store.recordAuditEvent({
        actor: 'system',
        event: 'memory.retrieve',
        subjectUserId: userId,
        coachId: coach.id,
        refs: { count: injectedMemories.length, ids: injectedMemories.map((m) => m.id) },
      });
      // Dormancy reset (ADR-004): bump expiry on retrieved durable memories.
      const durable = injectedMemories.filter((m) => m.kind !== 'summary').map((m) => m.id);
      if (durable.length) {
        await store.bumpCoachMemoryExpiry(durable, userId, expiresAtFor('fact', nowMs ?? Date.now()));
      }
    }
  }
  const block = buildMemoryBlock(injectedMemories);
  const injectedInstructions = block ? `${scenario.aiInstructions}\n\n${block}` : scenario.aiInstructions;

  // 2) Run the session, tagged with coach_id.
  const result: VoiceSessionResult = transcript
    ? await persistClientSession({ store, scenario, vendor, userId, coachId: coach.id, transcript })
    : await runVoiceSession({ store, scenario, vendor, userId, coachId: coach.id, instructions: injectedInstructions });

  // 3) Write derived memories (consent-gated; ADR-004).
  let wroteMemories = 0;
  let memorySkippedReason: string | null = null;
  if (!userId) {
    memorySkippedReason = 'anonymous session (no user id) — nothing persisted';
  } else {
    const consent = await getCoachConsent(store, userId, coach.id);
    if (!consent.persistentMemory) {
      memorySkippedReason = 'persistent-memory consent not granted';
    } else {
      const derived = deriveMemories(result.transcript, coach.name);
      const writeNow = nowMs ?? Date.now();
      for (const d of derived) {
        await store.writeCoachMemory({
          coachId: coach.id,
          userId,
          kind: d.kind,
          content: d.content,
          embedding: embed(d.content),
          sourceSessionId: result.sessionId,
          salience: d.salience,
          expiresAt: expiresAtFor(d.kind, writeNow),
        });
      }
      wroteMemories = derived.length;
      if (wroteMemories) {
        await store.recordAuditEvent({
          actor: 'system',
          event: 'memory.write',
          subjectUserId: userId,
          coachId: coach.id,
          refs: { count: wroteMemories, kinds: derived.map((d) => d.kind), sessionId: result.sessionId },
        });
      }
    }
  }

  return { ...result, injectedMemories, injectedInstructions, wroteMemories, memorySkippedReason };
}
