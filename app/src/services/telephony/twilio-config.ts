/**
 * Twilio configuration resolution (SAU-270) — env-first, exactly like the calendar
 * adapter (`GOOGLE_CALENDAR_ACCESS_TOKEN`) and the realtime keys
 * (`OPENAI_API_KEY ?? Settings`). Telephony creds are provisioned out-of-band
 * (CISO/board approval) and NEVER committed; absent creds ⇒ the factory picks the
 * mock (AC #2).
 *
 * Resolution order for each value:
 *   1. Environment variable (the board's `app/.env.local` pattern).
 *   2. (optional) the SAU-253 Integrations "Phone call" user_setting — reused as a
 *      config store so the seam the board already sees stays the source of record.
 *      We only READ it here; the Settings UI/schema is unchanged.
 *
 * Phase-0/1 spike note: the auth token is read but only used for inbound webhook
 * SIGNATURE verification (+ the bridge-stream HMAC, SAU-541) — we never place outbound calls (TCPA scope = later phase).
 */

import { signBridgeStream, type BridgeStreamParams } from './bridge-auth';

export interface TwilioConfig {
  /** Twilio Account SID (ACxxxx). Presence of SID+token selects the live adapter. */
  accountSid: string;
  /**
   * Twilio Auth Token — used ONLY to verify inbound `X-Twilio-Signature` and to
   * sign/verify the bridge stream parameters that carry that trust forward (SAU-541).
   */
  authToken: string;
  /** The provisioned test number (E.164), for logs/routing. Optional. */
  phoneNumber?: string;
  /**
   * Public wss:// base of our media-stream bridge server, e.g.
   * `wss://abc123.ngrok.io` (a tunnel in dev) or the deployed host. The webhook
   * appends the bridge path; per-call values ride as signed `<Parameter>`s. Without it we cannot bridge ⇒ fail soft.
   */
  bridgePublicUrl?: string;
  /**
   * When false, inbound webhook signature checks are skipped (dev/tunnel only).
   * Defaults to true whenever an auth token is present.
   */
  verifySignatures: boolean;
}

/** Shape of the SAU-253 `integration:phone` user_setting value (read-only here). */
export interface PhoneIntegrationSetting {
  status?: string;
  sipTrunkUri?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  bridgePublicUrl?: string;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

/**
 * Resolve Twilio config from env, optionally folding in a previously-loaded phone
 * integration setting (kept pure/sync — the caller does the async DB read). Returns
 * null when no account credentials are configured (⇒ mock).
 */
export function resolveTwilioConfig(setting?: PhoneIntegrationSetting | null): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? setting?.twilioAccountSid;
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? setting?.twilioAuthToken;
  if (!accountSid || !authToken) return null;
  return {
    accountSid,
    authToken,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? setting?.twilioPhoneNumber,
    bridgePublicUrl: process.env.TELEPHONY_PUBLIC_URL ?? setting?.bridgePublicUrl,
    verifySignatures: bool(process.env.TWILIO_VERIFY_SIGNATURES, true),
  };
}

/** Path the bridge WebSocket server listens on (kept in one place). */
export const BRIDGE_WS_PATH = '/telephony/bridge';

/** Local port for the standalone media-stream bridge server. */
export function bridgeServerPort(): number {
  const raw = process.env.TELEPHONY_BRIDGE_PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5050;
}

/**
 * Public wss:// URL of the bridge socket — bare, no query string: Twilio's
 * `<Stream url>` does not support query strings (custom values ride in
 * `<Parameter>`s, see {@link bridgeStreamFor}). Null when no public URL is
 * configured (⇒ webhook fails soft).
 */
export function bridgeWsUrlFor(cfg: TwilioConfig): string | null {
  if (!cfg.bridgePublicUrl) return null;
  return `${cfg.bridgePublicUrl.replace(/\/+$/, '')}${BRIDGE_WS_PATH}`;
}

/** What a webhook hands Twilio's `<Connect><Stream>`: where to stream + what to echo back. */
export interface BridgeStream {
  url: string;
  /** Emitted as `<Parameter>`s; Twilio returns them in the `start` frame. */
  parameters: BridgeStreamParams;
}

/**
 * The stream for one inbound call (SAU-541): scenario `slug` + dialed number
 * (`to`, the tenant key from SAU-525 — the `start` frame does not otherwise carry
 * it), signed with the auth token the webhook was just verified with, valid for
 * {@link BRIDGE_STREAM_TTL_SEC}. Null when no public bridge URL is configured.
 */
export function bridgeStreamFor(
  cfg: TwilioConfig,
  scenarioSlug: string,
  dialedNumber?: string | null,
  nowMs = Date.now(),
): BridgeStream | null {
  const url = bridgeWsUrlFor(cfg);
  if (!url) return null;
  return { url, parameters: signBridgeStream(cfg.authToken, scenarioSlug, dialedNumber, nowMs) };
}

/**
 * Must the bridge verify a signed stream? Yes unless `TWILIO_VERIFY_SIGNATURES=false`
 * (the same documented dev escape hatch as the webhook). Fails CLOSED: with no auth
 * token configured there is nothing to verify against, so the bridge refuses.
 */
export function bridgeAuthRequired(): boolean {
  return bool(process.env.TWILIO_VERIFY_SIGNATURES, true);
}
