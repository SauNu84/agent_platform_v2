/**
 * Gemini Live browser-transport config (SAU-259, Phase 2.1).
 *
 * The SAU-258 Gemini *server* adapter (src/voice/adapters/gemini.ts) connects to
 * the Live `BidiGenerateContent` WebSocket with the raw `GEMINI_API_KEY` — fine
 * server-side, but the key must NEVER reach the browser. So the browser live path
 * mirrors the OpenAI ephemeral-secret pattern: the server mints a short-lived
 * **ephemeral auth token** (this file builds the request), hands it to the client,
 * and the client opens its OWN WebSocket to Gemini with `?access_token=<token>`.
 *
 * This module is PURE and import-safe from BOTH the server route and the client
 * bundle (no `ws`, no Node-only APIs, no network) so the token request shape, the
 * voice catalog, the WS URL, and the setup frame are defined ONCE and can be unit
 * tested. The actual `fetch` to mint the token lives in the token route; the actual
 * WebSocket + audio live in the browser transport (src/lib/gemini-live-client.ts).
 *
 * Ephemeral tokens require the Live API's **v1alpha** surface (the server adapter
 * uses v1beta with a raw key); both are env-overridable so a deployment can repoint
 * without a code change — same config-seam discipline as the engine router.
 */

/** Gemini Live host (REST for token mint + WS for the session). Override via env. */
export const GEMINI_LIVE_HOST =
  process.env.GEMINI_LIVE_HOST || process.env.NEXT_PUBLIC_GEMINI_LIVE_HOST || 'generativelanguage.googleapis.com';

/** WS path for the bidi Live session (v1alpha — required for ephemeral-token auth). */
export const GEMINI_LIVE_WS_PATH =
  process.env.GEMINI_LIVE_WS_PATH ||
  '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

/** REST path for minting an ephemeral auth token (v1alpha). */
export const GEMINI_AUTH_TOKEN_PATH = '/v1alpha/auth_tokens';

/** Gemini Live native audio rates (PCM16 mono) — input 16 kHz, output 24 kHz. */
export const GEMINI_INPUT_SAMPLE_RATE = 16_000;
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;

/**
 * Gemini Live prebuilt voices (distinct from OpenAI's catalog). A scenario's stored
 * voice may be an OpenAI name like 'alloy' or a UI label — anything outside this set
 * falls back to the configured default, since Gemini rejects unknown voice names.
 */
export const GEMINI_VOICES = [
  'Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Zephyr',
] as const;

export type GeminiVoice = (typeof GEMINI_VOICES)[number];

export const DEFAULT_GEMINI_VOICE: GeminiVoice = 'Aoede';

export function isGeminiVoice(v: unknown): v is GeminiVoice {
  return typeof v === 'string' && (GEMINI_VOICES as readonly string[]).includes(v);
}

/** The voice to hand Gemini Live: the scenario's choice if valid, else env/default. */
export function resolveGeminiVoice(voiceName: unknown, envVoice?: string): GeminiVoice {
  if (isGeminiVoice(voiceName)) return voiceName;
  if (isGeminiVoice(envVoice)) return envVoice;
  return DEFAULT_GEMINI_VOICE;
}

/** Full REST URL to mint an ephemeral auth token (server-only; embeds the API key). */
export function geminiAuthTokenUrl(apiKey: string): string {
  return `https://${GEMINI_LIVE_HOST}${GEMINI_AUTH_TOKEN_PATH}?key=${encodeURIComponent(apiKey)}`;
}

/** Default ephemeral-token lifetime knobs (env-overridable). */
const TOKEN_TTL_MS = Number(process.env.GEMINI_TOKEN_TTL_MS) || 30 * 60_000; // token valid ~30 min
const NEW_SESSION_TTL_MS = Number(process.env.GEMINI_NEW_SESSION_TTL_MS) || 2 * 60_000; // must connect within ~2 min

/**
 * Ephemeral auth-token request body. We mint a SINGLE-USE token with a short
 * connect window; the browser then sends the full setup frame on connect (the same
 * shape the server adapter sends), so the token only authorizes the session — it
 * does not need to embed the model config. `nowMs` is injected for testability.
 */
export function geminiAuthTokenBody(nowMs: number): {
  uses: number;
  expireTime: string;
  newSessionExpireTime: string;
} {
  return {
    uses: 1,
    expireTime: new Date(nowMs + TOKEN_TTL_MS).toISOString(),
    newSessionExpireTime: new Date(nowMs + NEW_SESSION_TTL_MS).toISOString(),
  };
}

/** Browser WS URL for the Live session, authed with the ephemeral token (no API key). */
export function geminiLiveWsUrl(token: string): string {
  return `wss://${GEMINI_LIVE_HOST}${GEMINI_LIVE_WS_PATH}?access_token=${encodeURIComponent(token)}`;
}

export interface GeminiSetupTool {
  name: string;
  description?: string;
  paramsSchema?: unknown;
}

/**
 * The Live `setup` frame the browser sends as its FIRST message — mirrors the
 * server adapter (src/voice/adapters/gemini.ts) so both transports configure the
 * session identically: AUDIO out, chosen voice, the compiled system instruction
 * (KB already bounded upstream), and native in/out transcription so we capture
 * both sides of the call for the transcript + metering.
 */
export function geminiSetupFrame(opts: {
  model: string;
  voice: string;
  instructions: string;
  tools?: GeminiSetupTool[];
}): Record<string, unknown> {
  const model = opts.model.startsWith('models/') ? opts.model : `models/${opts.model}`;
  return {
    setup: {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } },
      },
      systemInstruction: { parts: [{ text: opts.instructions }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: opts.tools && opts.tools.length
        ? [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.paramsSchema })) }]
        : undefined,
    },
  };
}
