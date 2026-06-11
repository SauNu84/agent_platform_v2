/**
 * AI model registry (SAU-238, board ask #6).
 *
 * The Scenario settings expose an "AI Model" selector. Today the platform runs on
 * **OpenAI** (Realtime `gpt-realtime` for live voice); the registry is the single
 * place future providers get added, so the UI and any provider routing stay in
 * sync. Options marked `available: false` render as "coming soon" (disabled) — we
 * don't offer a control that doesn't work yet.
 */
export type ModelBadge = 'Recommended' | 'New' | 'Soon';

export interface AiModelOption {
  id: string;
  label: string;
  badge?: ModelBadge;
  available: boolean;
}

export const AI_MODELS: AiModelOption[] = [
  { id: 'openai-realtime', label: 'OpenAI Realtime (gpt-realtime)', badge: 'Recommended', available: true },
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
