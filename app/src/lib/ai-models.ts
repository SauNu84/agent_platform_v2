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
 * Engine class describes how an engine maps to plan tiers (the picker offers a
 * VENDOR; the viewer's plan sets the quality tier automatically — CPO decision on
 * SAU-258):
 *   - `cost`   — one cheap engine on every plan (e.g. Gemini Flash Live).
 *   - `tiered` — free / paid each have their own engine lever, SAME vendor
 *                (OpenAI Realtime: VOICE_ENGINE_FREE / VOICE_ENGINE_PAID; both default
 *                to gpt-realtime-2.1-mini since SAU-534).
 * There is no separately-selectable premium row to "lock"; free-tier protection is
 * the router's automatic downgrade (a free viewer of a tiered engine runs the
 * standard engine and is never billed at the premium rate).
 */
export type EngineClass = 'cost' | 'tiered';

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
  'Engine is selected by the viewer’s plan (SAU-534: every plan currently runs gpt-realtime-2.1-mini).';

export const AI_MODELS: AiModelOption[] = [
  {
    id: 'google-gemini',
    label: 'Google Gemini 2.5 Flash Live',
    vendor: 'gemini',
    engineClass: 'cost',
    available: true,
    badge: 'Recommended',
    hint: 'Fastest, lowest cost — about ⅓ the price of OpenAI Realtime. Great for high-volume practice. Available on every plan.',
  },
  {
    id: 'openai-realtime',
    label: 'OpenAI Realtime',
    vendor: 'openai',
    engineClass: 'tiered',
    available: true,
    hint: 'OpenAI’s realtime voice model. Paid plans add longer sessions and more minutes.',
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
 * with scenarios authored before SAU-258 and consistency with the single
 * "OpenAI Realtime (tiered)" entry the board accepted in SAU-256 — free viewers
 * run the standard engine, paid get the premium one (the router handles tiering).
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
