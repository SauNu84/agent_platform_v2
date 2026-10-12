/**
 * Plan feature entitlements (SAU-557, from the CPO decision on SAU-552) — the
 * single seam every non-voice paid feature is gated through. Voice allowances
 * stay in voice-policy.ts; everything else a plan unlocks is answered here.
 *
 * THIS IS THE ONLY PLAN GATE. A feature moved behind `planFeatures` must not keep
 * a second plan/tier check at its call site (CTO constraint 2 on SAU-557): two
 * gates that can disagree make the effective behaviour "whichever runs first".
 *
 * What is NOT a plan feature, by ruling:
 *   - The Memory-settings view / export / delete / revoke controls (ADR-004 data-
 *     subject rights) are available on EVERY tier, Free included (CISO SAU-558 C4).
 *     `csvExport` covers the session-history and creator-analytics CSVs only.
 *   - Consent is not a plan gate. Coach memory is `coachMemory AND consent`, and
 *     both halves are evaluated once, together, in `coachMemoryAccess`
 *     (coach-memory-access.ts — kept separate so this table stays client-safe for
 *     the plan catalog copy).
 */
import type { EntitlementRecord, Store } from '@/db/store';
import type { PlanTier } from './engine-router';

export interface PlanFeatures {
  /** Coach persistent memory (retrieve + write). Also requires consent — see coachMemoryAccess. */
  coachMemory: boolean;
  /** Session-history + creator-analytics CSV export. NOT the Memory-settings data export. */
  csvExport: boolean;
}

export type PlanFeature = keyof PlanFeatures;

const FEATURES: Record<PlanTier, PlanFeatures> = {
  free: { coachMemory: false, csvExport: false },
  standard: { coachMemory: false, csvExport: false },
  premium: { coachMemory: true, csvExport: true },
};

/** Normalise a stored plan tier. Unknown/absent ⇒ free (the safe default). */
export function resolvePlanTier(planTier?: string | null): PlanTier {
  return planTier === 'standard' || planTier === 'premium' ? planTier : 'free';
}

/** The feature set a billing plan tier unlocks. */
export function planFeatures(planTier?: PlanTier | string | null): PlanFeatures {
  return FEATURES[resolvePlanTier(planTier)];
}

/**
 * Effective billing tier of an entitlement row. Prefer the named `planTier`
 * (SAU-250); fall back to the coarse `plan` flag so a legacy paid row without a
 * named tier still resolves to a paid tier rather than free.
 */
export function effectivePlanTier(ent: Pick<EntitlementRecord, 'plan' | 'planTier'>): PlanTier {
  if (ent.planTier && ent.planTier !== 'free') return ent.planTier;
  return ent.plan === 'paid' ? 'standard' : 'free';
}

/** A user's effective plan tier. Anonymous / no entitlement ⇒ free. */
export async function resolvePlanTierForUser(store: Store, userId: string | null): Promise<PlanTier> {
  if (!userId) return 'free';
  const ent = await store.getEntitlement(userId);
  return ent ? effectivePlanTier(ent) : 'free';
}
