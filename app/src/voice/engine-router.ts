/**
 * Tiered voice model router (SAU-256, Phase 1 of the HYBRID build-vs-buy plan).
 *
 * The board-accepted strategy (SAU-255, confirmation `9d416103`): cut blended
 * voice COGS ~50–65% with no UX loss for free users by routing voice sessions to
 * a *cheaper engine for the free tier* and the "Super" engine for paid — both
 * behind the existing `RealtimeVoiceProvider` seam (ADR-003), so swapping or
 * adding engines (Gemini 2.5 Flash Live, a cascaded Whisper/Kokoro pipeline)
 * later never re-architects anything.
 *
 * THE ENGINE IDS ARE A CONFIG SEAM — never hard-coded at a call site:
 *   - free tier → VOICE_ENGINE_FREE (default `gpt-realtime-mini`, ~½ cost, same vendor, drop-in)
 *   - paid tier → VOICE_ENGINE_PAID (default `gpt-realtime`, the "Super" engine)
 * Override either via env to point at a different model without a deploy of new
 * code paths. A future Gemini/cascaded engine is added by giving its model id a
 * `vendor` here (and an adapter behind the seam) — the router contract is stable.
 *
 * Tier is resolved from the user's billing `plan_tier` (SAU-250): `free` →
 * free engine; `standard`/`premium` → paid engine. The router is also
 * cap-aware: it surfaces a configurable per-tier voice-minute budget so a future
 * free-tier minute cap (CPO product policy, out of scope here) can read it
 * without re-architecting the router.
 */
import type { Vendor } from './session-service';
import type { Store } from '@/db/store';

export type VoiceTier = 'free' | 'paid';

/** Billing tier from SAU-250's `user_entitlement.plan_tier`. */
export type PlanTier = 'free' | 'standard' | 'premium';

export interface VoiceEngine {
  /** stable tier key this engine serves */
  tier: VoiceTier;
  /** realtime model id passed to the vendor adapter (e.g. `gpt-realtime-mini`) */
  model: string;
  /** which adapter behind the seam serves this engine */
  vendor: Extract<Vendor, 'openai'>;
  /** human label for logs/observability */
  label: string;
}

/** Drop-in cheaper engine for the free tier (same vendor, ~½ the cost). */
const DEFAULT_FREE_ENGINE = 'gpt-realtime-mini';
/** The "Super" engine for paid tiers. */
const DEFAULT_PAID_ENGINE = 'gpt-realtime';

/**
 * Resolve the engine model id for a tier from config (env), never hard-coded.
 * `OPENAI_REALTIME_MODEL` remains honored as a global override for the paid/super
 * engine to stay backward-compatible with prior single-engine deployments.
 */
function engineModelFor(tier: VoiceTier): string {
  if (tier === 'free') {
    return process.env.VOICE_ENGINE_FREE || DEFAULT_FREE_ENGINE;
  }
  return process.env.VOICE_ENGINE_PAID || process.env.OPENAI_REALTIME_MODEL || DEFAULT_PAID_ENGINE;
}

/** Map the billing plan_tier → a voice tier. Unknown/absent ⇒ free (safe default). */
export function resolveVoiceTier(planTier?: PlanTier | string | null): VoiceTier {
  return planTier === 'standard' || planTier === 'premium' ? 'paid' : 'free';
}

/**
 * Resolve the voice tier for a user from their billing entitlement (SAU-250).
 * Anonymous / no-entitlement users default to the free tier (cheaper engine).
 */
export async function resolveTierForUser(store: Store, userId: string | null): Promise<VoiceTier> {
  if (!userId) return 'free';
  const ent = await store.getEntitlement(userId);
  return resolveVoiceTier(ent?.planTier);
}

/** The config-driven engine for a voice tier. */
export function resolveVoiceEngine(tier: VoiceTier): VoiceEngine {
  const model = engineModelFor(tier);
  return {
    tier,
    model,
    vendor: 'openai',
    label: tier === 'free' ? `Free voice (${model})` : `Super voice (${model})`,
  };
}

/**
 * Per-tier voice-minute budget (cap-aware seam). Returns null when uncapped.
 * The router does NOT enforce the cap (that is product/billing policy, CPO-owned,
 * tracked separately) — it only reads a configurable budget so a cap feature can
 * land without re-architecting. Free tier defaults to the existing
 * `CREDIT_FREE_MINUTES` (30) so the router agrees with the Slice-2 meter; paid is
 * uncapped by default but metered (never "unlimited" — board/CFO, SAU-220/222).
 */
export function tierMinuteBudget(tier: VoiceTier): number | null {
  if (tier === 'free') {
    const v = process.env.VOICE_FREE_MINUTE_BUDGET ?? process.env.CREDIT_FREE_MINUTES;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 30;
  }
  const v = process.env.VOICE_PAID_MINUTE_BUDGET;
  if (v == null || v === '') return null; // metered, no hard cap by default
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Cost lever #2 (SAU-256): bound the Knowledge Base (SAU-243) text folded into a
 * VOICE session's system prompt. The 150K-char text budget (KB_CONTEXT_CHAR_BUDGET)
 * is far too large to pay for on every realtime turn — it bloats the cached prefix
 * and the per-turn input cost. Voice sessions get a much tighter budget (default
 * 16K chars ≈ ~4K tokens), configurable via VOICE_KB_CHAR_BUDGET. This keeps the
 * injected prompt small AND stable, which is exactly what lets the realtime
 * prompt-cache (cost lever #1) serve the prefix from cache turn-over-turn.
 */
export const DEFAULT_VOICE_KB_CHAR_BUDGET = 16_000;

export function voiceKbCharBudget(): number {
  const n = Number(process.env.VOICE_KB_CHAR_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_VOICE_KB_CHAR_BUDGET;
}
