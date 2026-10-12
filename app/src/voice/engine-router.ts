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
 *   - free tier → VOICE_ENGINE_FREE (default `gpt-realtime-2.1-mini`)
 *   - paid tier → VOICE_ENGINE_PAID (default `gpt-realtime-2.1-mini` — SAU-534: both
 *     tiers run mini; paid value is minutes + session length + features, SAU-552)
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
import type { Store } from '@/db/store';
import {
  DEFAULT_AI_MODEL, aiModelById, type AiModelOption, type EngineClass, type VoiceVendor,
} from '@/lib/ai-models';

export type VoiceTier = 'free' | 'paid';
export type { VoiceVendor };

/** Billing tier from SAU-250's `user_entitlement.plan_tier`. */
export type PlanTier = 'free' | 'standard' | 'premium';

export interface VoiceEngine {
  /** stable tier key this session was routed at */
  tier: VoiceTier;
  /** the selectable catalog id this engine resolved to (post-gating) */
  modelId: string;
  /** realtime model id passed to the vendor adapter (e.g. `gpt-realtime-mini`) */
  model: string;
  /** which adapter behind the seam serves this engine */
  vendor: VoiceVendor;
  /** cost (one engine for all) vs tiered (free→standard, paid→premium) */
  engineClass: EngineClass;
  /** human label for logs/observability + UI */
  label: string;
  /** true when a free viewer of a TIERED engine runs the standard (not premium) engine */
  downgraded: boolean;
}

/**
 * SAU-534 (CPO engine ruling): BOTH web tiers run `gpt-realtime-2.1-mini`. The two
 * levers stay separate so a deployment can split them again by env alone — and
 * `downgraded` (below) follows whatever is actually configured, so the free-tier
 * "upgrade for better quality" notice can never claim a difference that isn't there.
 */
const DEFAULT_FREE_ENGINE = 'gpt-realtime-2.1-mini';
const DEFAULT_PAID_ENGINE = 'gpt-realtime-2.1-mini';
/** The premium OpenAI engine — only reachable via a clinic's `premium` grade now. */
const DEFAULT_PREMIUM_ENGINE = 'gpt-realtime';
/** Google Gemini 2.5 Flash native-audio Live engine (SAU-258, ~⅓ the cost). */
const DEFAULT_GEMINI_ENGINE = 'gemini-2.5-flash-preview-native-audio-dialog';

/**
 * Resolve the concrete realtime model id an option maps to for a tier, from config
 * (env), never hard-coded at a call site. Each lever has its own override so a
 * deployment can point an engine at a different model without new code:
 *   - OpenAI free → VOICE_ENGINE_FREE   (default gpt-realtime-2.1-mini)
 *   - OpenAI paid → VOICE_ENGINE_PAID   (or legacy OPENAI_REALTIME_MODEL; default 2.1-mini)
 *   - Gemini Flash Live      → VOICE_ENGINE_GEMINI
 * Gemini is the same cheap engine on every plan; OpenAI Realtime is tiered.
 */
function concreteModelFor(opt: AiModelOption, tier: VoiceTier): string {
  if (opt.vendor === 'gemini') return process.env.VOICE_ENGINE_GEMINI || DEFAULT_GEMINI_ENGINE;
  if (opt.vendor === 'openai') {
    return tier === 'free'
      ? process.env.VOICE_ENGINE_FREE || DEFAULT_FREE_ENGINE
      : process.env.VOICE_ENGINE_PAID || process.env.OPENAI_REALTIME_MODEL || DEFAULT_PAID_ENGINE;
  }
  // Unknown vendor (e.g. a future provider not yet runnable) → safest cost engine.
  return process.env.VOICE_ENGINE_FREE || DEFAULT_FREE_ENGINE;
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

/**
 * SAU-258 — resolve the engine for a session from the scenario's chosen model id
 * (author default = a VENDOR, persisted in metadata._model) AND the viewer's tier.
 * The picker offers a vendor; the plan sets the quality tier automatically:
 *   - an unknown / not-yet-runnable id falls back to the default engine;
 *   - a `cost` engine (Gemini) runs the same model on every plan;
 *   - a `tiered` engine (OpenAI Realtime) runs the standard model for free viewers
 *     and the premium model for paid — the free viewer is never billed at premium.
 * This is the single place selection + entitlement are reconciled.
 */
export function resolveSessionEngine(opts: { modelId?: string | null; tier: VoiceTier }): VoiceEngine {
  const { tier } = opts;
  let opt = aiModelById(opts.modelId ?? undefined);
  // Not-yet-wired engine (e.g. "coming soon") → default runnable engine.
  if (!opt.available) opt = aiModelById(DEFAULT_AI_MODEL);
  return {
    tier,
    modelId: opt.id,
    model: concreteModelFor(opt, tier),
    vendor: opt.vendor,
    engineClass: opt.engineClass,
    label: opt.label,
    // A free viewer of a tiered engine is "downgraded" only if the configured free
    // model actually differs from the paid one (SAU-557: since SAU-534 they don't).
    downgraded: tier === 'free' && tieredEngineDiffers(opt),
  };
}

/**
 * True iff a paid viewer would get a DIFFERENT model than a free viewer on this
 * engine — the only condition under which an "upgrade for better quality" claim is
 * true. Derived from the live config, so flipping VOICE_ENGINE_PAID/FREE can never
 * leave the UI describing the old split (SAU-557 / CTO constraint 1).
 */
export function tieredEngineDiffers(opt: AiModelOption = aiModelById(DEFAULT_AI_MODEL)): boolean {
  return opt.engineClass === 'tiered' && concreteModelFor(opt, 'free') !== concreteModelFor(opt, 'paid');
}

// ── Per-tenant engine binding (SAU-525) ──────────────────────────────────────
/**
 * Engine GRADE a tenant's phone calls run on, decoupled from the payer's billing
 * tier. The web path ties engine to plan (free → standard, paid → premium); a
 * clinic on a $399/mo plan is a *paid* payer whose calls must still run on the
 * cost engine — the SAU-455 price sheet is only ≥70% GM on mini. So the tenant
 * carries its own grade and the router resolves the concrete model from it.
 */
export type EngineGrade = 'standard' | 'premium';

/** The Clinic Secretary archetype default: every clinic call runs standard unless bound otherwise. */
export const CLINIC_DEFAULT_ENGINE_GRADE: EngineGrade = 'standard';

export interface TenantEngine extends VoiceEngine {
  /** the grade the tenant was resolved at (after the paid-only gate on premium). */
  grade: EngineGrade;
}

/**
 * Resolve the engine for a TENANT-attributed session (the telephony path):
 *   - `grade` is the tenant's binding (clinic.voice_engine); null ⇒ `defaultGrade`.
 *   - `premium` is a PAID-ONLY grade: a free-tier payer is never billed at premium,
 *     the same invariant the web path enforces via `downgraded`.
 *   - the concrete model has its OWN levers so the clinic path can be pointed at a
 *     different model without moving web users: VOICE_ENGINE_TENANT_STANDARD /
 *     VOICE_ENGINE_TENANT_PREMIUM, falling back to the tier levers (FREE / PAID).
 * `tier` on the result is the ROUTING tier the model was picked at (standard ⇒
 * 'free' path engine); callers meter against the payer's billing tier separately.
 */
export function resolveTenantEngine(opts: {
  modelId?: string | null;
  /** the payer's billing tier (from their entitlement) */
  tier: VoiceTier;
  /** the tenant's bound grade; null/undefined ⇒ defaultGrade */
  grade?: EngineGrade | null;
  defaultGrade?: EngineGrade;
}): TenantEngine {
  const wanted = opts.grade ?? opts.defaultGrade ?? CLINIC_DEFAULT_ENGINE_GRADE;
  const grade: EngineGrade = wanted === 'premium' && opts.tier === 'paid' ? 'premium' : 'standard';
  const engine = resolveSessionEngine({ modelId: opts.modelId, tier: grade === 'premium' ? 'paid' : 'free' });
  if (engine.vendor === 'openai') {
    const override = grade === 'premium'
      ? process.env.VOICE_ENGINE_TENANT_PREMIUM
      : process.env.VOICE_ENGINE_TENANT_STANDARD;
    if (override) engine.model = override;
    // With both web tiers on mini (SAU-534), the PAID lever's default is no longer a
    // premium model; a premium-bound clinic keeps the premium default unless a lever
    // is explicitly set.
    else if (grade === 'premium' && !process.env.VOICE_ENGINE_PAID && !process.env.OPENAI_REALTIME_MODEL) {
      engine.model = DEFAULT_PREMIUM_ENGINE;
    }
  }
  return { ...engine, grade };
}

/**
 * The config-driven engine for a voice tier when no scenario model is specified.
 * Backward-compatible with SAU-256: resolves the default scenario engine
 * (`openai-realtime`, tiered) for the tier from the FREE/PAID levers, so existing
 * single-engine callers are unchanged.
 */
export function resolveVoiceEngine(tier: VoiceTier): VoiceEngine {
  return resolveSessionEngine({ modelId: DEFAULT_AI_MODEL, tier });
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
