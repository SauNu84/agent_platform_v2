/**
 * AI voice-engine registry (SAU-238 ask #6 → SAU-258 multi-model picker).
 *
 * The Scenario settings expose an "AI Model" selector. Since the SAU-256 tiered
 * router and now SAU-258 (Phase 2 of the multi-model voice plan, SAU-254), this is
 * a REAL model picker: an author chooses which voice engine powers their scenario,
 * across vendors (OpenAI Realtime, Google Gemini Live, …). The stored id is the
 * scenario's default engine; the runtime engine-router honours it per session and
 * enforces tier gating (free tier → cost engines only; paid → full choice).
 *
 * This module is the SINGLE source of truth for the picker, kept PURE (no server
 * imports) so it is safe to import from both the client authoring form and the
 * server-side engine-router. Concrete realtime model ids + env overrides live in
 * `@/voice/engine-router` (the runtime seam); this module owns presentation +
 * selection metadata (vendor, cost class, availability, hints).
 *
 * Availability: `available: true` means the engine is wired and runnable behind
 * the realtime seam (a missing API key fails soft to the mock adapter, not a
 * crash). Options marked `available: false` render as "coming soon" (disabled) —
 * we never offer a control that does nothing.
 */
export type ModelBadge = 'Recommended' | 'New' | 'Soon';

/** Realtime voice vendors behind the seam (ADR-003). */
export type VoiceVendor = 'openai' | 'gemini' | 'anthropic';

/**
 * Cost class drives tier gating: `cost` engines are free-tier eligible (cheap),
 * `premium` engines require a paid plan (the "Super" engine). A free viewer of a
 * scenario whose default is a premium engine is transparently downgraded to a
 * same-vendor cost engine by the router — never billed at the premium rate.
 */
export type EngineClass = 'cost' | 'premium';

export interface AiModelOption {
  /** stable id stored in scenario metadata._model and resolved by the router */
  id: string;
  /** real vendor/engine name shown in the picker */
  label: string;
  vendor: VoiceVendor;
  engineClass: EngineClass;
  /** wired & runnable behind the seam (key-less ⇒ mock fallback, never a crash) */
  available: boolean;
  badge?: ModelBadge;
  /** one-line speed / cost / quality hint shown beside the option */
  hint?: string;
  /** longer clarifying note (e.g. tiered-engine behaviour) */
  note?: string;
}

/**
 * How the OpenAI Realtime "Super" engine maps plan tier → engine (SAU-256/258).
 * Surfaced in the UI so the per-scenario setting accurately reflects what runs:
 * a free viewer is auto-routed to the cheaper engine, paid gets the premium one.
 */
export const OPENAI_REALTIME_TIER_NOTE =
  'Engine is selected by the viewer’s plan: free → gpt-realtime-mini, paid → gpt-realtime.';

export const AI_MODELS: AiModelOption[] = [
  {
    id: 'google-gemini',
    label: 'Google Gemini 2.5 Flash Live',
    vendor: 'gemini',
    engineClass: 'cost',
    available: true,
    badge: 'Recommended',
    hint: 'Fastest, lowest cost — about ⅓ the price of gpt-realtime. Great for high-volume practice. Available on every plan.',
  },
  {
    id: 'openai-realtime-mini',
    label: 'OpenAI gpt-realtime mini',
    vendor: 'openai',
    engineClass: 'cost',
    available: true,
    hint: 'Low cost, strong quality. The default engine for the free tier. Available on every plan.',
  },
  {
    id: 'openai-realtime',
    label: 'OpenAI gpt-realtime (Premium)',
    vendor: 'openai',
    engineClass: 'premium',
    available: true,
    hint: 'Highest-quality OpenAI voice. Paid plans only — free viewers run on gpt-realtime-mini.',
    note: OPENAI_REALTIME_TIER_NOTE,
  },
  {
    id: 'anthropic-claude',
    label: 'Anthropic Claude',
    vendor: 'anthropic',
    engineClass: 'cost',
    available: false,
    badge: 'Soon',
  },
];

/**
 * Default scenario engine. Kept as `openai-realtime` for backward compatibility
 * with scenarios authored before SAU-258 (it stays the premium OpenAI engine, so
 * paid viewers still get gpt-realtime and free viewers are auto-downgraded to
 * gpt-realtime-mini — exactly the pre-existing SAU-256 tiered behaviour).
 */
export const DEFAULT_AI_MODEL = 'openai-realtime';

/** Look up an engine option by id, falling back to the default for unknown ids. */
export function aiModelById(id?: string | null): AiModelOption {
  return AI_MODELS.find((x) => x.id === id) ?? AI_MODELS.find((x) => x.id === DEFAULT_AI_MODEL)!;
}

/** Human label for a stored model id (falls back to the default). */
export function aiModelLabel(id?: string): string {
  return aiModelById(id).label;
}

/** True when the id names a currently-runnable engine. */
export function isAvailableModel(id?: string): boolean {
  return !!AI_MODELS.find((x) => x.id === id)?.available;
}

/**
 * Whether a tier may SELECT this engine directly (authoring-time gating). Premium
 * engines are paid-only; cost engines are available on every plan. Unknown ids
 * resolve to the default option. (Runtime never hard-fails a free viewer of a
 * premium scenario — the router downgrades — but the picker should not let a free
 * author pick an engine their own sessions can't run at full quality.)
 */
export function isModelSelectableForTier(id: string | undefined, tier: 'free' | 'paid'): boolean {
  const opt = AI_MODELS.find((x) => x.id === id);
  if (!opt || !opt.available) return false;
  return tier === 'paid' || opt.engineClass === 'cost';
}
