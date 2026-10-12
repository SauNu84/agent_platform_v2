/**
 * Coach-memory data-subject controls (ADR-004 §User controls) — view / export /
 * delete — plus the memory gate's state for the Memory-settings surface (SAU-557).
 *
 * NOT PLAN-GATED, by ruling (CISO SAU-558 C4): GDPR Art. 15/17/20 rights don't
 * depend on payment, so every function here works on EVERY tier, Free included.
 * The plan only decides whether memory is *used* (coach-memory-access.ts); it never
 * decides whether the user can see, take or delete what we hold.
 */
import type { CoachMemoryRecord, Store } from '@/db/store';
import type { CoachRecord } from '@/domain/coach';
import { coachMemoryAccess, type CoachMemoryAccess } from '@/voice/coach-memory-access';
import { resolvePlanTierForUser } from '@/voice/plan-features';

export type ExportedMemory = Omit<CoachMemoryRecord, 'embedding'>;

export interface CoachMemoryView {
  memories: ExportedMemory[];
  /** the single memory gate's verdict for this (user, coach) */
  access: CoachMemoryAccess;
  /**
   * When access is `paused`: the real `max(expires_at)` of what we hold — the date
   * by which it's all gone on its normal schedule (CISO SAU-558 C5). Null otherwise,
   * or when nothing is held.
   */
  pausedUntil: string | null;
}

/** Latest expiry among held memories (ISO), or null when none. */
export function latestExpiry(memories: Pick<CoachMemoryRecord, 'expiresAt'>[]): string | null {
  let max: number | null = null;
  for (const m of memories) {
    const t = Date.parse(m.expiresAt);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max).toISOString();
}

/**
 * VIEW / EXPORT everything this coach remembers about the user. The export (API
 * GET) is audited, count only; an in-page render passes `audit: false`.
 */
export async function viewCoachMemory(
  store: Store,
  userId: string,
  coach: CoachRecord,
  opts: { audit?: boolean } = {},
): Promise<CoachMemoryView> {
  const memories = await store.listCoachMemory(coach.id, userId);
  if (opts.audit !== false) {
    await store.recordAuditEvent({
      actor: `user:${userId}`, event: 'export', subjectUserId: userId, coachId: coach.id,
      refs: { count: memories.length },
    });
  }
  const planTier = await resolvePlanTierForUser(store, userId);
  const access = await coachMemoryAccess(store, { userId, coachId: coach.id, planTier });
  return {
    // Export shape omits the embedding vector (large, internal).
    memories: memories.map(({ embedding: _embedding, ...rest }) => rest),
    access,
    pausedUntil: access === 'paused' ? latestExpiry(memories) : null,
  };
}

/** DELETE one memory (`id`) or WIPE all for (coach, user). Audited (ids/counts only). */
export async function deleteCoachMemoryFor(
  store: Store,
  userId: string,
  coach: CoachRecord,
  id?: string | null,
): Promise<{ deleted: number; found: boolean }> {
  if (id) {
    const ok = await store.deleteCoachMemory(coach.id, userId, id);
    await store.recordAuditEvent({
      actor: `user:${userId}`, event: 'memory.delete', subjectUserId: userId, coachId: coach.id,
      refs: { id, deleted: ok },
    });
    return { deleted: ok ? 1 : 0, found: ok };
  }
  const purged = await store.wipeCoachMemory(coach.id, userId);
  await store.recordAuditEvent({
    actor: `user:${userId}`, event: 'memory.delete', subjectUserId: userId, coachId: coach.id,
    refs: { wiped: purged },
  });
  return { deleted: purged, found: true };
}
