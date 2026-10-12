/**
 * Coach session orchestration (Slice 3) — the memory loop that makes a Coach more
 * than a Scenario (ADR-001 + ADR-004):
 *
 *   1. RETRIEVE the most relevant memories for (coach, user) and inject them into
 *      the agent's instructions ("what you remember about this learner").
 *   2. RUN the session through the same realtime seam as a Scenario, tagged with
 *      coach_id (server-driven with the mock/OpenAI, or client-driven transcript).
 *   3. WRITE derived memories from the transcript.
 *
 * Steps 1 and 3 run only when `coachMemoryAccess` is `active` — the plan includes
 * memory (SAU-557) AND persistent-memory consent is granted (ADR-004). It is
 * evaluated ONCE, before `listCoachMemory`, so a paused or revoked user gets no
 * retrieval, no expiry bump and no write (CISO SAU-558 C2). Audit every
 * retrieve/write (counts only, no PII).
 *
 * So session N+1 demonstrably picks up what session N learned.
 */
import { runVoiceSession, persistClientSession, type Vendor, type VoiceSessionResult } from './session-service';
import type { PlanTier, VoiceTier } from './engine-router';
import { coachMemoryAccess, type CoachMemoryAccess } from './coach-memory-access';
import type { Transcript } from './realtime-interface';
import type { CoachMemoryRecord, Store } from '@/db/store';
import type { CoachRecord } from '@/domain/coach';
import type { ScenarioRecord } from '@/domain/scenario';
import { buildMemoryBlock, deriveMemories, embed, expiresAtFor, rankMemories } from '@/coach/memory';
import { trackSafe } from '@/services/product-analytics';
import { PRODUCT_EVENTS } from '@/domain/analytics-events';

export interface CoachSessionResult extends VoiceSessionResult {
  /** memories retrieved + injected into this session's agent instructions */
  injectedMemories: CoachMemoryRecord[];
  /** the instructions actually sent to the agent (scenario persona + memory block) */
  injectedInstructions: string;
  /** how many derived memories were written from this session's transcript */
  wroteMemories: number;
  /** why memory wasn't used (plan/consent/anonymous), or null if it was */
  memorySkippedReason: string | null;
  /** the single memory gate's verdict for this (user, coach) */
  memoryAccess: CoachMemoryAccess;
}

const SKIPPED_REASON: Record<Exclude<CoachMemoryAccess, 'active'>, string> = {
  anonymous: 'anonymous session (no user id) — nothing persisted',
  paused: 'coach memory paused — not included in the current plan',
  no_consent: 'persistent-memory consent not granted',
};

export interface RunCoachSessionOptions {
  store: Store;
  coach: CoachRecord;
  scenario: ScenarioRecord;        // resolved from coach.scenarioId by the caller
  vendor: Vendor;
  /** voice tier (SAU-256): selects the engine + metered tier. Default 'free'. */
  tier?: VoiceTier;
  /** billing plan tier (SAU-557): gates coach memory via planFeatures. Default 'free'. */
  planTier?: PlanTier;
  /** scenario's chosen engine id (SAU-258, metadata._model); router gates by tier. */
  modelId?: string | null;
  userId: string | null;
  /** client-driven path: a transcript the browser already produced */
  transcript?: Transcript;
  /** retrieval "now" (ms) for deterministic tests; defaults to wall clock */
  nowMs?: number;
  /** how many memories to inject (token budget); default from rankMemories */
  k?: number;
}

export async function runCoachSession(opts: RunCoachSessionOptions): Promise<CoachSessionResult> {
  const { store, coach, scenario, vendor, tier = 'free', planTier = 'free', modelId = null, userId, transcript, nowMs, k } = opts;

  // 0) The memory gate — plan AND consent, evaluated once, before any memory read.
  const memoryAccess = await coachMemoryAccess(store, { userId, coachId: coach.id, planTier });

  // 1) Retrieve + inject memory.
  let injectedMemories: CoachMemoryRecord[] = [];
  if (memoryAccess === 'active' && userId) {
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
      await trackSafe(store, {
        event: PRODUCT_EVENTS.COACH_MEMORY_RECALLED,
        surface: 'voice',
        actorId: userId,
        props: { count: injectedMemories.length },
      });
    }
  }
  const block = buildMemoryBlock(injectedMemories);
  const injectedInstructions = block ? `${scenario.aiInstructions}\n\n${block}` : scenario.aiInstructions;

  // 2) Run the session, tagged with coach_id.
  const result: VoiceSessionResult = transcript
    ? await persistClientSession({ store, scenario, vendor, tier, modelId, userId, coachId: coach.id, transcript })
    : await runVoiceSession({ store, scenario, vendor, tier, modelId, userId, coachId: coach.id, instructions: injectedInstructions });

  // 3) Write derived memories (same gate as step 1).
  let wroteMemories = 0;
  const memorySkippedReason = memoryAccess === 'active' ? null : SKIPPED_REASON[memoryAccess];
  if (memoryAccess === 'active' && userId) {
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

  return { ...result, injectedMemories, injectedInstructions, wroteMemories, memorySkippedReason, memoryAccess };
}
