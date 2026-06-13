/**
 * PHI-path voice gate (SAU-277, WS5 — Phase-1 HIPAA go-live gate SAU-272).
 *
 * The CEO-ratified PHI voice path is a SINGLE vendor: OpenAI Realtime + a signed
 * BAA + Zero-Data-Retention, on a dedicated prod org/project key isolated from any
 * free/dev/consumer key. This module is the enforcement seam: a scenario flagged as
 * carrying real PHI (`metadata._phi === true`) may ONLY mint a Realtime session
 * against that dedicated BAA+ZDR key. It may NEVER:
 *   - use the consumer `OPENAI_API_KEY`,
 *   - use a per-user key self-provisioned in Settings → AI Model, or
 *   - use the Gemini consumer endpoint (not BAA-covered).
 *
 * Synthetic / training scenarios (the default, `_phi` absent or false) are
 * untouched — they keep the existing env?-then-Settings key resolution. The gate
 * only bites the moment a scenario is marked PHI, which is the SAU-268 trigger
 * ("first real patient via real call OR real clinic calendar").
 *
 * ZDR cannot be asserted programmatically against OpenAI, so go-live additionally
 * requires `OPENAI_PHI_ZDR_CONFIRMED` — an explicit operator flag set only after
 * Zero-Data-Retention is confirmed in writing on the BAA org. No flag ⇒ PHI voice
 * is refused (fail-closed), never silently downgraded to a non-compliant key.
 */
import type { VoiceVendor } from '@/lib/ai-models';

export interface PhiCredential {
  ok: boolean;
  /** Present only when ok — the dedicated BAA+ZDR prod org/project key. */
  apiKey?: string;
  /** HTTP status to return when !ok. */
  status?: number;
  /** Operator-facing reason when !ok. */
  error?: string;
}

/** Env vars that gate the PHI voice path. Kept in one place for the readiness doc. */
export const PHI_ENV = {
  /** Dedicated OpenAI prod org/project key covered by the BAA + ZDR. */
  KEY: 'OPENAI_PHI_API_KEY',
  /** Set to "true"/"1" ONLY after ZDR is confirmed in writing on the BAA org. */
  ZDR_CONFIRMED: 'OPENAI_PHI_ZDR_CONFIRMED',
} as const;

function envFlag(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * A scenario carries real PHI when `metadata._phi === true`. Anything else
 * (absent, false, non-boolean) is treated as synthetic — fail-safe default.
 */
export function isPhiScenario(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?._phi === true;
}

/**
 * Resolve the voice credential for a PHI-path session, fail-closed. Returns the
 * dedicated BAA+ZDR key only when (a) the vendor is OpenAI, (b) ZDR is confirmed,
 * and (c) the dedicated key is configured. Any other state is refused with a
 * specific status/reason — and crucially never returns a consumer/per-user key.
 */
export function resolvePhiVoiceCredential(
  vendor: VoiceVendor,
  env: Record<string, string | undefined> = process.env,
): PhiCredential {
  // The Gemini consumer endpoint is out of the PHI path (CEO-ratified single path).
  if (vendor !== 'openai') {
    return {
      ok: false,
      status: 422,
      error:
        'PHI voice path is OpenAI Realtime + BAA + ZDR only. The Gemini consumer ' +
        'endpoint is not BAA-covered and cannot carry PHI (SAU-277).',
    };
  }
  // ZDR must be confirmed in writing on the BAA org before any PHI flows.
  if (!envFlag(env[PHI_ENV.ZDR_CONFIRMED])) {
    return {
      ok: false,
      status: 403,
      error:
        `PHI voice path disabled: ${PHI_ENV.ZDR_CONFIRMED} is not set. ` +
        'Zero-Data-Retention must be confirmed in writing on the BAA org first.',
    };
  }
  const key = env[PHI_ENV.KEY];
  if (!key) {
    return {
      ok: false,
      status: 403,
      error:
        `PHI voice path disabled: ${PHI_ENV.KEY} (dedicated BAA+ZDR prod org key) ` +
        'is not configured. PHI must never fall back to a consumer or per-user key.',
    };
  }
  return { ok: true, apiKey: key };
}
