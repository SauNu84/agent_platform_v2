/**
 * Bridge-socket authentication (SAU-541) — PURE, no `ws`/network.
 *
 * The inbound-call webhook is authenticated (`X-Twilio-Signature`), but the media
 * socket it points Twilio at was not: anyone with the tunnel URL could open a call
 * and burn a tenant's minute cap. We carry the webhook's trust forward instead of
 * adding a secret: the webhook signs `slug|to|exp` with the account auth token and
 * hands the result to Twilio as `<Stream><Parameter>`s; Twilio echoes them in the
 * Media Streams `start` frame (`start.customParameters`) and the bridge verifies
 * them before admitting the call.
 *
 * Why `<Parameter>` and not `?query`: Twilio's `<Stream url>` does NOT support
 * query strings — custom values only reach the socket via the `start` frame.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a signed stream stays valid after the webhook answered. */
export const BRIDGE_STREAM_TTL_SEC = 120;

/** The custom parameters the webhook emits and the bridge expects back. */
export interface BridgeStreamParams {
  slug: string;
  /** Dialed number (E.164) — the tenant key (SAU-525). Empty when unknown. */
  to: string;
  /** Unix seconds after which the bridge refuses the stream. */
  exp: string;
  /** base64url HMAC-SHA256(authToken, v1|slug|to|exp). */
  sig: string;
}

export type BridgeAuthResult =
  | { ok: true; slug: string; to: string | null }
  | { ok: false; reason: 'missing_signature' | 'expired' | 'bad_signature' };

function mac(authToken: string, slug: string, to: string, exp: string): string {
  // Versioned + newline-delimited so no (slug, to) pair can collide with another.
  return createHmac('sha256', authToken).update(`v1\n${slug}\n${to}\n${exp}`, 'utf8').digest('base64url');
}

/** Sign the stream a webhook is about to hand Twilio. */
export function signBridgeStream(
  authToken: string,
  slug: string,
  to: string | null | undefined,
  nowMs = Date.now(),
  ttlSec = BRIDGE_STREAM_TTL_SEC,
): BridgeStreamParams {
  const exp = String(Math.floor(nowMs / 1000) + ttlSec);
  const dialed = to ?? '';
  return { slug, to: dialed, exp, sig: mac(authToken, slug, dialed, exp) };
}

/** Verify the `start.customParameters` a bridge socket presented. Constant-time compare. */
export function verifyBridgeStream(
  authToken: string,
  params: Partial<Record<string, string>> | null | undefined,
  nowMs = Date.now(),
): BridgeAuthResult {
  const slug = params?.slug;
  const exp = params?.exp;
  const sig = params?.sig;
  const to = params?.to ?? '';
  if (!slug || !exp || !sig) return { ok: false, reason: 'missing_signature' };

  const expected = Buffer.from(mac(authToken, slug, to, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }
  // Checked after the MAC so a forged `exp` can't be used to probe the clock.
  const expSec = Number(exp);
  if (!Number.isFinite(expSec) || Math.floor(nowMs / 1000) > expSec) return { ok: false, reason: 'expired' };
  return { ok: true, slug, to: to || null };
}

export type BridgeAdmitAuth =
  | { ok: true; slug: string | null; to: string | null; verified: boolean }
  | { ok: false; reason: 'not_configured' | 'missing_signature' | 'expired' | 'bad_signature' | 'replayed' };

/**
 * Single-use guard for signed streams (CISO N1): a param set that opened one call
 * can't open a second within its TTL. In-memory per bridge process — enough while
 * the bridge is one process; entries are dropped once their `exp` has passed.
 */
export class SeenStreamSignatures {
  private seen = new Map<string, number>();

  /** True the first time `sig` is presented; false on any replay. */
  claim(sig: string, expSec: number, nowMs = Date.now()): boolean {
    const nowSec = Math.floor(nowMs / 1000);
    for (const [s, exp] of this.seen) if (exp < nowSec) this.seen.delete(s);
    if (this.seen.has(sig)) return false;
    this.seen.set(sig, expSec);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * The bridge's gate, run on the `start` frame BEFORE tenant admission.
 *  - `required` (default): only a stream the webhook signed gets in; slug/to come
 *    from the SIGNED parameters only — never from the URL. No auth token ⇒ refuse.
 *  - `TWILIO_VERIFY_SIGNATURES=false` (dev escape hatch): unsigned streams are let
 *    through, slug/to read from the parameters or, for local synthetic callers, the
 *    connection URL's query string.
 */
export function authorizeBridgeStream(opts: {
  customParameters: Record<string, string>;
  requestUrl?: string;
  authToken: string | null | undefined;
  required: boolean;
  nowMs?: number;
  /** Claimed only AFTER the MAC verifies, so forged sigs can't fill it. */
  seen?: SeenStreamSignatures;
}): BridgeAdmitAuth {
  if (opts.required) {
    if (!opts.authToken) return { ok: false, reason: 'not_configured' };
    const v = verifyBridgeStream(opts.authToken, opts.customParameters, opts.nowMs);
    if (!v.ok) return v;
    if (opts.seen && !opts.seen.claim(opts.customParameters.sig, Number(opts.customParameters.exp), opts.nowMs)) {
      return { ok: false, reason: 'replayed' };
    }
    return { ok: true, slug: v.slug, to: v.to, verified: true };
  }
  let query: URLSearchParams | null = null;
  try {
    query = new URL(opts.requestUrl ?? '', 'http://localhost').searchParams;
  } catch {
    /* unparseable URL ⇒ parameters only */
  }
  const slug = opts.customParameters.slug || query?.get('slug') || null;
  const to = opts.customParameters.to || query?.get('to') || null;
  return { ok: true, slug, to, verified: false };
}
