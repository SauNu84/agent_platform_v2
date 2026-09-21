/**
 * OpenAI Realtime usage accounting — pure helpers shared by the browser/server
 * provider adapter (`adapters/openai`) and the telephony bridge transport
 * (SAU-525: the bridge meters the same measured tokens as the web path, so a
 * phone call and a web session land in `voice_usage` with identical semantics).
 * No network, no `ws` — safe to unit-test and to import anywhere.
 */
import type { TurnUsage, SessionUsage } from './realtime-interface';

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/**
 * Parse one `response.done.usage` object → vendor-neutral TurnUsage.
 *
 * GA Realtime usage shape (per token, summed by the API across the response):
 *   usage.input_token_details  = { text_tokens, audio_tokens, cached_tokens,
 *                                  cached_tokens_details: { text_tokens, audio_tokens } }
 *   usage.output_token_details = { text_tokens, audio_tokens }
 * `cached_tokens` is the portion of input_tokens served from the prompt cache;
 * `cached_tokens_details` splits it by modality. When the modality split is
 * absent (older shapes) we fall back to attributing all cached tokens to audio,
 * since a voice turn's input is ~entirely audio — the conservative (lower-savings)
 * assumption for a cost report.
 */
export function parseUsage(u: any): TurnUsage | null {
  if (!u) return null;
  const itd = u.input_token_details ?? {};
  const otd = u.output_token_details ?? {};
  const ctd = itd.cached_tokens_details ?? {};
  const inputText = n(itd.text_tokens);
  const inputAudio = n(itd.audio_tokens);
  const cachedTotal = n(itd.cached_tokens);
  let cachedText = n(ctd.text_tokens);
  let cachedAudio = n(ctd.audio_tokens);
  if (!cachedText && !cachedAudio && cachedTotal) {
    // No modality split → attribute cache to audio (voice input is ~all audio).
    cachedAudio = Math.min(cachedTotal, inputAudio);
    cachedText = Math.min(cachedTotal - cachedAudio, inputText);
  }
  return {
    inputTextTokens: inputText,
    inputAudioTokens: inputAudio,
    cachedTextTokens: cachedText,
    cachedAudioTokens: cachedAudio,
    outputTextTokens: n(otd.text_tokens),
    outputAudioTokens: n(otd.audio_tokens),
    totalTokens: n(u.total_tokens) || inputText + inputAudio + n(otd.text_tokens) + n(otd.audio_tokens),
  };
}

export function sumUsage(perTurn: TurnUsage[]): SessionUsage {
  const totals: TurnUsage = {
    inputTextTokens: 0, inputAudioTokens: 0, cachedTextTokens: 0,
    cachedAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0, totalTokens: 0,
  };
  for (const t of perTurn) {
    totals.inputTextTokens += t.inputTextTokens;
    totals.inputAudioTokens += t.inputAudioTokens;
    totals.cachedTextTokens += t.cachedTextTokens;
    totals.cachedAudioTokens += t.cachedAudioTokens;
    totals.outputTextTokens += t.outputTextTokens;
    totals.outputAudioTokens += t.outputAudioTokens;
    totals.totalTokens += t.totalTokens;
  }
  return { perTurn, totals };
}
