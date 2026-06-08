/**
 * Credit / voice-minute meter + cap enforcement (Slice 2 monetization guardrail).
 *
 * Read-model over `voice_usage` (the Slice-1 metering fact): sum a user's metered
 * `voice_minutes`, compare against their entitlement cap (free-tier minutes + any
 * paid minutes), and gate new sessions when the cap is exhausted.
 *
 * MVP enforcement point: BEFORE a session starts (Join). A session already in
 * flight is not hard-stopped mid-call — that needs in-session metering and is a
 * tracked follow-up; this slice delivers the pre-flight cap that the cost gates
 * (SAU-196/SAU-198) require so uncapped voice can never be served below target.
 */
import type { EntitlementRecord, Store } from '@/db/store';

/** Default free plan applied when a user has no explicit entitlement row. */
export const DEFAULT_FREE_MINUTES = Number(process.env.CREDIT_FREE_MINUTES ?? 30);

export interface MeterState {
  userId: string;
  plan: 'free' | 'paid';
  usedMinutes: number;
  capMinutes: number;
  remainingMinutes: number;
  overCap: boolean;
}

export class CapExceededError extends Error {
  constructor(public state: MeterState) {
    super(
      `voice-minute cap reached: used ${state.usedMinutes.toFixed(2)} of ${state.capMinutes.toFixed(2)} min ` +
      `(${state.plan} plan). Upgrade or wait for your allowance to reset.`,
    );
    this.name = 'CapExceededError';
  }
}

function defaultEntitlement(userId: string): EntitlementRecord {
  return { userId, plan: 'free', freeMinutes: DEFAULT_FREE_MINUTES, paidMinutes: 0 };
}

/** Compute a user's live meter state from recorded usage + their entitlement. */
export async function getMeterState(store: Store, userId: string): Promise<MeterState> {
  const [usedMinutes, ent] = await Promise.all([
    store.sumVoiceMinutesByUser(userId),
    store.getEntitlement(userId),
  ]);
  const entitlement = ent ?? defaultEntitlement(userId);
  const capMinutes = Number((entitlement.freeMinutes + entitlement.paidMinutes).toFixed(4));
  const remainingMinutes = Number(Math.max(0, capMinutes - usedMinutes).toFixed(4));
  return {
    userId,
    plan: entitlement.plan,
    usedMinutes: Number(usedMinutes.toFixed(4)),
    capMinutes,
    remainingMinutes,
    overCap: usedMinutes >= capMinutes,
  };
}

/** Throw `CapExceededError` when the user has no remaining voice minutes. */
export async function assertWithinCap(store: Store, userId: string): Promise<MeterState> {
  const state = await getMeterState(store, userId);
  if (state.overCap) throw new CapExceededError(state);
  return state;
}
