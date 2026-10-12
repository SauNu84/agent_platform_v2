/**
 * The single coach-memory gate (SAU-557): `planFeatures(tier).coachMemory AND
 * consent`, evaluated once. Split from plan-features.ts because consent pulls in
 * server-only code and the feature table is also read by the client plan catalog.
 */
import type { Store } from '@/db/store';
import { getCoachConsent } from '@/coach/consent';
import type { PlanTier } from './engine-router';
import { planFeatures } from './plan-features';

/**
 * Coach-memory state for one (user, coach):
 *   - `active`     — plan includes memory AND persistent-memory consent is granted.
 *   - `paused`     — consent stands but the plan doesn't include memory (e.g. after a
 *                    downgrade). Nothing is read, bumped, written or deleted; rows age
 *                    out on their ADR-004 expiry (CISO SAU-558).
 *   - `no_consent` — on a memory plan, but consent was never granted or was revoked.
 *   - `anonymous`  — no user id; nothing is ever persisted.
 */
export type CoachMemoryAccess = 'active' | 'paused' | 'no_consent' | 'anonymous';

/**
 * Evaluate `planFeatures(tier).coachMemory && consent` ONCE. Callers must check this
 * before `listCoachMemory`, so a non-active user gets no retrieval, no expiry bump
 * and no write (CISO SAU-558 C2).
 */
export async function coachMemoryAccess(
  store: Store,
  opts: { userId: string | null; coachId: string; planTier: PlanTier | string | null | undefined },
): Promise<CoachMemoryAccess> {
  if (!opts.userId) return 'anonymous';
  if (!planFeatures(opts.planTier).coachMemory) return 'paused';
  const consent = await getCoachConsent(store, opts.userId, opts.coachId);
  return consent.persistentMemory ? 'active' : 'no_consent';
}
