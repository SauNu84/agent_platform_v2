/**
 * Credit / voice-minute meter + cap enforcement (Slice 2 monetization guardrail,
 * extended by SAU-257 to a config-driven per-tier monthly cap).
 *
 * Read-model over `voice_usage` (the Slice-1 metering fact + SAU-256 per-tier
 * columns): sum a user's metered `voice_minutes` FOR THE CURRENT CALENDAR MONTH,
 * compare against their tier's voice budget (the SAU-257 VoicePolicy, config-
 * driven), and gate new sessions when the budget is exhausted.
 *
 * Monthly reset (SAU-257 AC#5) is implicit: usage is summed only since the start
 * of the current UTC month, so the free allotment "resets" when the month rolls
 * over — no cron, no batch job, the window simply moves.
 *
 * Enforcement points:
 *   - BEFORE a session starts (Join): pre-flight monthly-cap check (here).
 *   - The per-session soft cap (policy.voiceSessionMaxMinutes) is surfaced via
 *     `sessionAllowanceMinutes` so the client can bound a single session — one
 *     long call can't burn the whole monthly budget.
 *
 * On exhaustion the product policy is a graceful fallback to unlimited (non-
 * metered) text Chat (SAU-224) + an upgrade prompt — never a hard mid-value
 * paywall. The 402 response carries this full state so the UI can do that.
 */
import type { EntitlementRecord, Store } from '@/db/store';
import { voicePolicyForPlan, type VoicePolicy } from '@/voice/voice-policy';
import type { OnExhausted } from '@/voice/voice-policy';

/** Default free plan applied when a user has no explicit entitlement row. */
export const DEFAULT_FREE_MINUTES = Number(process.env.CREDIT_FREE_MINUTES ?? 30);

export interface MeterState {
  userId: string;
  plan: 'free' | 'paid';
  /** voice tier the policy resolved to (free|paid) — drives the engine + budget. */
  tier: VoicePolicy['tier'];
  /** voice minutes used in the current calendar month. */
  usedMinutes: number;
  /** monthly budget in minutes (from the user's entitlement row). */
  capMinutes: number;
  /** monthly minutes remaining (>= 0) this month. */
  remainingMinutes: number;
  /** soft per-session cap in minutes; null = no per-session cap. */
  sessionMaxMinutes: number | null;
  /** minutes available for the NEXT session = min(remaining, sessionMax). */
  sessionAllowanceMinutes: number;
  /** true once the month's budget is spent. */
  overCap: boolean;
  /** ISO timestamp when the monthly allotment resets (first of next UTC month). */
  resetsAt: string;
  /** what happens on exhaustion (graceful text-chat fallback). */
  onExhausted: OnExhausted;
  /** the resolved per-tier policy (config-driven entitlement). */
  policy: VoicePolicy;
}

export class CapExceededError extends Error {
  constructor(public state: MeterState) {
    super(
      `voice-minute cap reached: used ${state.usedMinutes.toFixed(2)} of ` +
      `${state.capMinutes.toFixed(2)} min this month ` +
      `(${state.tier} tier). Continue in text chat, or upgrade for more voice minutes.`,
    );
    this.name = 'CapExceededError';
  }
}

function defaultEntitlement(userId: string): EntitlementRecord {
  return { userId, plan: 'free', freeMinutes: DEFAULT_FREE_MINUTES, paidMinutes: 0, planTier: 'free' };
}

/**
 * Effective billing tier for policy resolution. Prefer the named `planTier`
 * (SAU-250); fall back to the coarse `plan` flag so a legacy paid row without a
 * named tier still resolves to a paid policy rather than free.
 */
function effectivePlanTier(ent: EntitlementRecord): 'free' | 'standard' | 'premium' {
  if (ent.planTier && ent.planTier !== 'free') return ent.planTier;
  return ent.plan === 'paid' ? 'standard' : 'free';
}

/** Start of the current UTC month + the reset boundary (first of next month). */
function monthBoundsUtc(now: Date = new Date()): { startMs: number; resetsAt: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { startMs: start.getTime(), resetsAt: next.toISOString() };
}

const round4 = (n: number) => Number(n.toFixed(4));

/** Compute a user's live meter state from this month's usage + their tier policy. */
export async function getMeterState(store: Store, userId: string): Promise<MeterState> {
  const { startMs, resetsAt } = monthBoundsUtc();
  const [usedMinutesRaw, ent] = await Promise.all([
    store.sumVoiceMinutesByUserSince(userId, startMs),
    store.getEntitlement(userId),
  ]);
  const entitlement = ent ?? defaultEntitlement(userId);
  const policy = voicePolicyForPlan(effectivePlanTier(entitlement));

  const usedMinutes = round4(usedMinutesRaw);
  // Monthly budget = the user's entitlement allotment (free + any paid minutes).
  // The free allotment defaults to the config-driven tier budget
  // (policy.voiceMinutesPerMonth = CREDIT_FREE_MINUTES), but the per-user
  // entitlement row remains the source of truth so a user can be granted more.
  // Paid-tier economics (overage, etc.) are unchanged here (SAU-220/SAU-222).
  const capMinutes = round4(entitlement.freeMinutes + entitlement.paidMinutes);

  const remainingMinutes = round4(Math.max(0, capMinutes - usedMinutes));
  const sessionMaxMinutes = policy.voiceSessionMaxMinutes;
  const sessionAllowanceMinutes =
    sessionMaxMinutes == null
      ? remainingMinutes
      : round4(Math.min(remainingMinutes, sessionMaxMinutes));

  return {
    userId,
    plan: entitlement.plan,
    tier: policy.tier,
    usedMinutes,
    capMinutes,
    remainingMinutes,
    sessionMaxMinutes,
    sessionAllowanceMinutes,
    overCap: capMinutes !== Infinity && usedMinutes >= capMinutes,
    resetsAt,
    onExhausted: policy.onExhausted,
    policy,
  };
}

/** Throw `CapExceededError` when the user has spent this month's voice budget. */
export async function assertWithinCap(store: Store, userId: string): Promise<MeterState> {
  const state = await getMeterState(store, userId);
  if (state.overCap) throw new CapExceededError(state);
  return state;
}
