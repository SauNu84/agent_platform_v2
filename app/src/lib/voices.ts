/**
 * OpenAI Realtime voice catalog (SAU-238 ask #10 — Appearance).
 *
 * These are the voices OpenAI Realtime accepts as a plain string. The Appearance
 * "Voice" selector stores one of these on the scenario (voice.name); the realtime
 * token route uses it directly so the choice is real (not cosmetic). Anything
 * outside this set falls back to the default, since OpenAI rejects unknown names.
 */
export const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse',
] as const;

export type OpenAiVoice = (typeof OPENAI_VOICES)[number];

export const DEFAULT_VOICE: OpenAiVoice = 'alloy';

export function isOpenAiVoice(v: unknown): v is OpenAiVoice {
  return typeof v === 'string' && (OPENAI_VOICES as readonly string[]).includes(v);
}

/** The voice to hand OpenAI Realtime: the scenario's choice if valid, else the env/default. */
export function resolveOpenAiVoice(voiceName: unknown, envVoice?: string): OpenAiVoice {
  if (isOpenAiVoice(voiceName)) return voiceName;
  if (isOpenAiVoice(envVoice)) return envVoice;
  return DEFAULT_VOICE;
}
