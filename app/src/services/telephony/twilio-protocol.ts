/**
 * Twilio wire protocol helpers (SAU-270) — PURE functions for the two Twilio
 * surfaces we touch, kept free of `ws`/network so they unit-test cleanly:
 *
 *   1. TwiML — the XML we return from the inbound-call webhook. `<Connect><Stream>`
 *      bridges the call's bidirectional audio to our media-stream WebSocket; the
 *      fail-soft path returns a polite spoken message + hangup.
 *   2. Media Streams frames — the JSON messages Twilio sends/expects over that
 *      WebSocket (start / media / stop inbound; media / clear / mark outbound).
 *      Audio is base64 G.711 μ-law @ 8 kHz, which OpenAI Realtime accepts directly
 *      (`g711_ulaw`) — so the bridge forwards bytes with NO transcoding.
 *   3. Request signature verification (`X-Twilio-Signature`, HMAC-SHA1).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// ── 1. TwiML ─────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

/**
 * TwiML that connects the inbound call to our bidirectional Media Stream. Twilio
 * opens a WebSocket to `streamUrl` and streams the caller's μ-law audio; we stream
 * the agent's audio back over the same socket.
 *
 * `parameters` become `<Parameter>`s, which Twilio echoes in the `start` frame's
 * `customParameters` — the ONLY way to pass per-call values: `<Stream url>` does
 * not support query strings.
 */
export function connectStreamTwiml(streamUrl: string, parameters?: Record<string, string>): string {
  const params = Object.entries(parameters ?? {})
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}" />`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Connect>' +
    (params ? `<Stream url="${escapeXml(streamUrl)}">${params}</Stream>` : `<Stream url="${escapeXml(streamUrl)}" />`) +
    '</Connect>' +
    '</Response>'
  );
}

/** Fail-soft TwiML: a brief spoken notice + hangup when telephony isn't configured. */
export function failSoftTwiml(message: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    `<Say>${escapeXml(message)}</Say>` +
    '<Hangup/>' +
    '</Response>'
  );
}

// ── 2. Media Streams frames ───────────────────────────────────────────────────

export interface TwilioStartEvent {
  event: 'start';
  streamSid: string;
  start: {
    streamSid: string;
    accountSid?: string;
    callSid?: string;
    mediaFormat?: { encoding?: string; sampleRate?: number; channels?: number };
    customParameters?: Record<string, string>;
  };
}
export interface TwilioMediaEvent {
  event: 'media';
  streamSid: string;
  media: { track?: string; chunk?: string; timestamp?: string; payload: string };
}
export interface TwilioStopEvent {
  event: 'stop';
  streamSid: string;
  stop?: { accountSid?: string; callSid?: string };
}
export type TwilioInboundFrame =
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent
  | { event: 'connected' | 'mark'; [k: string]: unknown };

/** Parse a raw text frame from the Twilio Media Streams socket; null if unparseable. */
export function parseTwilioFrame(raw: string | Buffer): TwilioInboundFrame | null {
  try {
    const obj = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    if (obj && typeof obj.event === 'string') return obj as TwilioInboundFrame;
    return null;
  } catch {
    return null;
  }
}

/** Outbound media frame: hand the agent's μ-law audio back to the caller. */
export function outboundMediaFrame(streamSid: string, muLawBase64: string): string {
  return JSON.stringify({ event: 'media', streamSid, media: { payload: muLawBase64 } });
}

/** Clear Twilio's outbound audio buffer — used on barge-in so the agent stops fast. */
export function clearFrame(streamSid: string): string {
  return JSON.stringify({ event: 'clear', streamSid });
}

/** A mark frame, so we can detect when a chunk of agent audio finished playing. */
export function markFrame(streamSid: string, name: string): string {
  return JSON.stringify({ event: 'mark', streamSid, mark: { name } });
}

// ── 3. Signature verification ─────────────────────────────────────────────────

/**
 * Validate Twilio's `X-Twilio-Signature` (HMAC-SHA1 of the full URL + the POST
 * params sorted by key and concatenated, base64-encoded with the account auth
 * token as the key). See Twilio's security docs. Returns false on any mismatch.
 */
export function verifyTwilioSignature(opts: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | null;
}): boolean {
  if (!opts.signature) return false;
  const sorted = Object.keys(opts.params).sort();
  let data = opts.url;
  for (const key of sorted) data += key + opts.params[key];
  const expected = createHmac('sha1', opts.authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
