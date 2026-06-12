/**
 * AI model registry (SAU-238, board ask #6).
 *
 * The Scenario settings expose an "AI Model" selector. It picks the *provider*
 * (today: OpenAI Realtime). The exact engine within that provider is no longer a
 * single fixed model — since the SAU-256 tiered router, it is chosen per session
 * by the viewer's plan tier: free → `gpt-realtime-mini` (cheaper), paid →
 * `gpt-realtime` (the "Super" engine). So this control is a provider/family
 * choice, and the per-tier engine is automatic (and config-driven via env).
 * The registry is the single place future providers get added, so the UI and any
 * provider routing stay in sync. Options marked `available: false` render as
 * "coming soon" (disabled) — we don't offer a control that doesn't work yet.
 */
export type ModelBadge = 'Recommended' | 'New' | 'Soon';

export interface AiModelOption {
  id: string;
  label: string;
  badge?: ModelBadge;
  available: boolean;
  /** Short clarifying note shown beside the option (e.g. tiered-engine behaviour). */
  note?: string;
}

/**
 * How the OpenAI Realtime provider maps plan tier → engine (SAU-256). Surfaced in
 * the UI so the per-scenario setting accurately reflects what actually runs.
 */
export const OPENAI_REALTIME_TIER_NOTE =
  'Engine is selected by the viewer’s plan: free → gpt-realtime-mini, paid → gpt-realtime.';

export const AI_MODELS: AiModelOption[] = [
  { id: 'openai-realtime', label: 'OpenAI Realtime (tiered)', badge: 'Recommended', available: true, note: OPENAI_REALTIME_TIER_NOTE },
  { id: 'anthropic-claude', label: 'Anthropic Claude', badge: 'Soon', available: false },
  { id: 'google-gemini', label: 'Google Gemini', badge: 'Soon', available: false },
];

export const DEFAULT_AI_MODEL = 'openai-realtime';

/** Human label for a stored model id (falls back to the default). */
export function aiModelLabel(id?: string): string {
  const m = AI_MODELS.find((x) => x.id === id);
  return (m ?? AI_MODELS.find((x) => x.id === DEFAULT_AI_MODEL)!).label;
}

/** True when the id names a currently-runnable model. */
export function isAvailableModel(id?: string): boolean {
  return !!AI_MODELS.find((x) => x.id === id)?.available;
}
