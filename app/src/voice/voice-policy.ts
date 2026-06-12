/**
 * Voice entitlement policy (SAU-257) — the config-driven, per-tier voice
 * allowance that the free-tier minute cap enforces. This is CPO rec #1 from the
 * voice-cost analysis (SAU-254): uncapped free voice is the cost bomb, so the
 * free tier gets a bounded monthly budget on the cheap engine, and on exhaustion
 * falls back to unlimited (non-metered) text Chat (SAU-224) rather than a hard
 * paywall mid-value.
 *
 * THE POLICY IS A CONFIG SEAM — never hard-coded at a call site. Every field is
 * resolved from config (env, with documented defaults) keyed off the user's
 * billing tier (SAU-250 `plan_tier`), so the numbers can be tuned without a code
 * change:
 *   - voiceMinutesPerMonth   — monthly voice-minute budget (free default 30; paid uncapped/metered)
 *   - voiceSessionMaxMinutes — soft per-session cap (free default 10; paid 25, SAU-220/222)
 *   - voiceEngine            — the tier's engine model id (from the SAU-256 router)
 *   - onExhausted            — what happens when the budget is spent (text-chat fallback)
 *
 * The minute budget + engine come from the SAU-256 tiered router (engine-router.ts)
 * so product policy and the routing/metering half agree on one source of truth.
 * The session cap is the new lever this issue adds.
 *
 * Default values (the "seed"): Free = 30 min/mo, 10 min/session, gpt-realtime-mini,
 * text_chat_fallback. Paid (standard/premium) = uncapped monthly (metered with
 * overage per SAU-220/222), 25 min/session, gpt-realtime.
 */
import {
  resolveVoiceEngine,
  resolveVoiceTier,
  tierMinuteBudget,
  type PlanTier,
  type VoiceTier,
} from './engine-router';

/** What happens when a tier's voice budget is exhausted. */
export type OnExhausted = 'text_chat_fallback';

export interface VoicePolicy {
  /** stable tier key this policy serves */
  tier: VoiceTier;
  /** monthly voice-minute budget; null = uncapped (paid, metered with overage) */
  voiceMinutesPerMonth: number | null;
  /** soft per-session cap in minutes; null = no per-session cap */
  voiceSessionMaxMinutes: number | null;
  /** the config-driven engine model id for this tier (SAU-256 router) */
  voiceEngine: string;
  /** behaviour on exhaustion — graceful fallback, never a hard mid-value paywall */
  onExhausted: OnExhausted;
}

/** Per-session soft caps (minutes). Free keeps one rep from burning the month. */
export const DEFAULT_FREE_SESSION_MAX = 10;
/** Paid session cap is the existing economics call (SAU-220/SAU-222). */
export const DEFAULT_PAID_SESSION_MAX = 25;

/** Resolve the per-session soft cap for a tier from config (env), with defaults. */
function sessionMaxFor(tier: VoiceTier): number | null {
  const raw = tier === 'free' ? process.env.VOICE_FREE_SESSION_MAX : process.env.VOICE_PAID_SESSION_MAX;
  const dflt = tier === 'free' ? DEFAULT_FREE_SESSION_MAX : DEFAULT_PAID_SESSION_MAX;
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  // explicit 0/negative ⇒ no per-session cap (uncapped session length)
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** The config-driven voice policy for a tier. */
export function resolveVoicePolicy(tier: VoiceTier): VoicePolicy {
  return {
    tier,
    voiceMinutesPerMonth: tierMinuteBudget(tier),
    voiceSessionMaxMinutes: sessionMaxFor(tier),
    voiceEngine: resolveVoiceEngine(tier).model,
    onExhausted: 'text_chat_fallback',
  };
}

/**
 * Resolve the voice policy for a billing plan tier (SAU-250 `plan_tier`).
 * Unknown/absent ⇒ free (the safe, cheapest default).
 */
export function voicePolicyForPlan(planTier?: PlanTier | string | null): VoicePolicy {
  return resolveVoicePolicy(resolveVoiceTier(planTier));
}
