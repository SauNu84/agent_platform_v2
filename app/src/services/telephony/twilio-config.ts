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
 * SIGNATURE verification — we never place outbound calls (TCPA scope = later phase).
 */

export interface TwilioConfig {
  /** Twilio Account SID (ACxxxx). Presence of SID+token selects the live adapter. */
  accountSid: string;
  /** Twilio Auth Token — used ONLY to verify inbound `X-Twilio-Signature`. */
  authToken: string;
  /** The provisioned test number (E.164), for logs/routing. Optional. */
  phoneNumber?: string;
  /**
   * Public wss:// base of our media-stream bridge server, e.g.
   * `wss://abc123.ngrok.io` (a tunnel in dev) or the deployed host. The webhook
   * appends the bridge path + `?slug=`. Without it we cannot bridge ⇒ fail soft.
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
 * Build the public wss:// URL the vendor should stream to for a given scenario.
 * `dialedNumber` (the webhook's `To`, SAU-525) rides along as `?to=` so the bridge
 * can resolve the tenant — Twilio's Media Streams `start` frame does not carry it.
 * Returns null when no public bridge URL is configured (⇒ webhook fails soft).
 */
export function bridgeWsUrlFor(cfg: TwilioConfig, scenarioSlug: string, dialedNumber?: string | null): string | null {
  if (!cfg.bridgePublicUrl) return null;
  const base = cfg.bridgePublicUrl.replace(/\/+$/, '');
  const to = dialedNumber ? `&to=${encodeURIComponent(dialedNumber)}` : '';
  return `${base}${BRIDGE_WS_PATH}?slug=${encodeURIComponent(scenarioSlug)}${to}`;
}
