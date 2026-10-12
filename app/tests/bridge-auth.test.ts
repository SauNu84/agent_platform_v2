/**
 * SAU-541 — the telephony bridge socket only admits streams the (signature-
 * verified) inbound webhook signed. Pure tests: HMAC sign/verify, the bridge gate,
 * and the TwiML that carries the signed values as <Parameter>s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signBridgeStream,
  verifyBridgeStream,
  authorizeBridgeStream,
  BRIDGE_STREAM_TTL_SEC,
} from '@/services/telephony/bridge-auth';
import { bridgeStreamFor, bridgeAuthRequired, type TwilioConfig } from '@/services/telephony/twilio-config';
import { connectStreamTwiml } from '@/services/telephony/twilio-protocol';
import { TwilioTelephonyAdapter } from '@/services/telephony/twilio-telephony';

const TOKEN = 'twilio-auth-token';
const NOW = Date.UTC(2026, 9, 12, 9, 0, 0);
const asRecord = (p: object) => ({ ...p }) as Record<string, string>;

test('valid signature admits; slug + to come back from the signed values', () => {
  const p = signBridgeStream(TOKEN, 'clinic-intake-booking', '+14155550123', NOW);
  assert.deepEqual(verifyBridgeStream(TOKEN, asRecord(p), NOW + 5_000), { ok: true, slug: 'clinic-intake-booking', to: '+14155550123' });
  // No dialed number is still a valid (signed) stream — admission then decides.
  const q = signBridgeStream(TOKEN, 's', null, NOW);
  assert.deepEqual(verifyBridgeStream(TOKEN, asRecord(q), NOW), { ok: true, slug: 's', to: null });
});

test('tampered to / slug / exp → bad_signature (another tenant\'s cap is not reachable)', () => {
  const p = signBridgeStream(TOKEN, 'clinic-intake-booking', '+14155550123', NOW);
  for (const tamper of [{ to: '+14155559999' }, { to: '' }, { slug: 'other' }, { exp: String(Number(p.exp) + 3600) }]) {
    assert.deepEqual(verifyBridgeStream(TOKEN, { ...asRecord(p), ...tamper }, NOW), { ok: false, reason: 'bad_signature' }, JSON.stringify(tamper));
  }
  // Wrong key (e.g. a different account) and a truncated sig also fail.
  assert.equal(verifyBridgeStream('other-token', asRecord(p), NOW).ok, false);
  assert.deepEqual(verifyBridgeStream(TOKEN, { ...asRecord(p), sig: p.sig.slice(0, 10) }, NOW), { ok: false, reason: 'bad_signature' });
});

test('expired stream → expired; exactly at exp still admits', () => {
  const p = signBridgeStream(TOKEN, 's', '+1', NOW);
  assert.equal(Number(p.exp), NOW / 1000 + BRIDGE_STREAM_TTL_SEC);
  assert.equal(verifyBridgeStream(TOKEN, asRecord(p), NOW + BRIDGE_STREAM_TTL_SEC * 1000).ok, true);
  assert.deepEqual(verifyBridgeStream(TOKEN, asRecord(p), NOW + (BRIDGE_STREAM_TTL_SEC + 1) * 1000), { ok: false, reason: 'expired' });
});

test('missing sig / exp / slug → missing_signature', () => {
  const p = asRecord(signBridgeStream(TOKEN, 's', '+1', NOW));
  for (const k of ['sig', 'exp', 'slug']) {
    const q = { ...p };
    delete q[k];
    assert.deepEqual(verifyBridgeStream(TOKEN, q, NOW), { ok: false, reason: 'missing_signature' }, k);
  }
  assert.deepEqual(verifyBridgeStream(TOKEN, {}, NOW), { ok: false, reason: 'missing_signature' });
  assert.deepEqual(verifyBridgeStream(TOKEN, null, NOW), { ok: false, reason: 'missing_signature' });
});

test('bridge gate (required): ignores the URL query entirely — only signed params count', () => {
  // The pre-SAU-541 attack: a bare socket with ?slug=&to=<victim number>.
  const attack = authorizeBridgeStream({
    customParameters: {},
    requestUrl: '/telephony/bridge?slug=clinic-intake-booking&to=%2B14155550123',
    authToken: TOKEN,
    required: true,
    nowMs: NOW,
  });
  assert.deepEqual(attack, { ok: false, reason: 'missing_signature' });

  const p = asRecord(signBridgeStream(TOKEN, 'clinic-intake-booking', '+14155550123', NOW));
  const ok = authorizeBridgeStream({ customParameters: p, requestUrl: '/telephony/bridge?to=%2B19999999999', authToken: TOKEN, required: true, nowMs: NOW });
  assert.deepEqual(ok, { ok: true, slug: 'clinic-intake-booking', to: '+14155550123', verified: true });
});

test('bridge gate fails CLOSED with no auth token configured', () => {
  const p = asRecord(signBridgeStream(TOKEN, 's', '+1', NOW));
  for (const authToken of [undefined, null, '']) {
    assert.deepEqual(authorizeBridgeStream({ customParameters: p, authToken, required: true, nowMs: NOW }), { ok: false, reason: 'not_configured' });
  }
});

test('TWILIO_VERIFY_SIGNATURES=false (dev hatch): unsigned streams pass, query fallback for synthetic callers', () => {
  const prev = process.env.TWILIO_VERIFY_SIGNATURES;
  try {
    delete process.env.TWILIO_VERIFY_SIGNATURES;
    assert.equal(bridgeAuthRequired(), true, 'default is required');
    process.env.TWILIO_VERIFY_SIGNATURES = 'false';
    assert.equal(bridgeAuthRequired(), false);
  } finally {
    if (prev === undefined) delete process.env.TWILIO_VERIFY_SIGNATURES;
    else process.env.TWILIO_VERIFY_SIGNATURES = prev;
  }
  assert.deepEqual(
    authorizeBridgeStream({ customParameters: { synthetic: 'sau293' }, requestUrl: '/telephony/bridge?slug=s&to=%2B1', authToken: null, required: false }),
    { ok: true, slug: 's', to: '+1', verified: false },
  );
  assert.deepEqual(
    authorizeBridgeStream({ customParameters: { slug: 'p', to: '+2' }, requestUrl: '/telephony/bridge?slug=s', authToken: null, required: false }),
    { ok: true, slug: 'p', to: '+2', verified: false },
    'parameters win over the query',
  );
});

test('webhook → TwiML carries the signed values as <Stream><Parameter>s that verify', () => {
  const cfg: TwilioConfig = { accountSid: 'AC', authToken: TOKEN, bridgePublicUrl: 'wss://t.test', verifySignatures: true };
  const stream = bridgeStreamFor(cfg, 'clinic-intake-booking', '+14155550123', NOW)!;
  const twiml = new TwilioTelephonyAdapter(cfg).answerInbound({
    scenarioSlug: 'clinic-intake-booking',
    bridgeWsUrl: stream.url,
    bridgeParameters: { ...stream.parameters },
  }).body;
  assert.match(twiml, /<Stream url="wss:\/\/t\.test\/telephony\/bridge"><Parameter /);
  assert.doesNotMatch(twiml, /bridge\?/, 'no query string on the Stream url');
  // Round-trip: what Twilio would echo in start.customParameters verifies.
  const echoed: Record<string, string> = {};
  for (const m of twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)" \/>/g)) echoed[m[1]] = m[2];
  assert.deepEqual(verifyBridgeStream(TOKEN, echoed, NOW + 1000), { ok: true, slug: 'clinic-intake-booking', to: '+14155550123' });
  // No parameters ⇒ the original self-closing form.
  assert.equal(connectStreamTwiml('wss://x'), '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x" /></Connect></Response>');
});

// ── Socket level: the real bridge server refuses before admission ────────────────
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { startBridgeServer } from '@/telephony/bridge-server';

async function dialBridge(port: number, customParameters: Record<string, string>, query = ''): Promise<{ code: number; reason: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/telephony/bridge${query}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'connected' }));
      ws.send(JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters } }));
    });
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}

test('bridge server: unsigned / tampered streams get 1008 before any tenant or OpenAI work', async () => {
  const saved = { ...process.env };
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  delete process.env.TWILIO_VERIFY_SIGNATURES;
  delete process.env.TELEPHONY_PROVIDER;
  delete process.env.OPENAI_API_KEY; // a stream that passes auth then stops at the key gate (1011)
  const origLog = console.log;
  console.log = () => {};
  const wss = startBridgeServer(0);
  try {
    await new Promise((r) => wss.once('listening', r));
    const port = (wss.address() as AddressInfo).port;

    const attack = await dialBridge(port, {}, '?slug=clinic-intake-booking&to=%2B14155550123');
    assert.deepEqual(attack, { code: 1008, reason: 'stream refused: missing_signature' });

    const p = asRecord(signBridgeStream(TOKEN, 'clinic-intake-booking', '+14155550123'));
    const tampered = await dialBridge(port, { ...p, to: '+14155559999' });
    assert.deepEqual(tampered, { code: 1008, reason: 'stream refused: bad_signature' });

    const expired = await dialBridge(port, asRecord(signBridgeStream(TOKEN, 's', '+1', Date.now() - 10 * 60_000)));
    assert.deepEqual(expired, { code: 1008, reason: 'stream refused: expired' });

    // A genuinely signed stream gets PAST auth (next gate: no OpenAI key ⇒ 1011).
    const signed = await dialBridge(port, p);
    assert.equal(signed.code, 1011);
    assert.match(signed.reason, /no OPENAI_API_KEY/);
    // …and the same signed params can't open a second call (N1).
    assert.deepEqual(await dialBridge(port, p), { code: 1008, reason: 'stream refused: replayed' });
  } finally {
    await new Promise((r) => wss.close(r));
    console.log = origLog;
    process.env = saved;
  }
});

// ── CISO R1: no signing oracle — trust is carried forward only if it existed ──────
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { SeenStreamSignatures } from '@/services/telephony/bridge-auth';
import { POST as incomingCall } from '@/app/api/telephony/twilio/incoming-call/route';

const paramsIn = (twiml: string) => {
  const out: Record<string, string> = {};
  for (const m of twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)" \/>/g)) out[m[1]] = m[2];
  return out;
};

test('R1: verifySignatures=false ⇒ webhook mints NO sig; the verifying bridge refuses the stream', () => {
  const cfg: TwilioConfig = { accountSid: 'AC', authToken: TOKEN, bridgePublicUrl: 'wss://t.test', verifySignatures: false };
  const stream = bridgeStreamFor(cfg, 'clinic-intake-booking', '+14155550123', NOW)!;
  assert.equal(stream.signed, false);
  assert.deepEqual(stream.parameters, { slug: 'clinic-intake-booking', to: '+14155550123' });
  const twiml = new TwilioTelephonyAdapter(cfg).answerInbound({
    scenarioSlug: 'clinic-intake-booking', bridgeWsUrl: stream.url, bridgeParameters: { ...stream.parameters },
  }).body;
  const echoed = paramsIn(twiml);
  assert.equal(echoed.sig, undefined, 'no sig <Parameter>');
  assert.equal(echoed.exp, undefined, 'no exp <Parameter>');
  assert.deepEqual(
    authorizeBridgeStream({ customParameters: echoed, authToken: TOKEN, required: true, nowMs: NOW }),
    { ok: false, reason: 'missing_signature' },
  );
  // Dev bridge (also unverified) still routes it — localhost synthetic work keeps working.
  assert.deepEqual(
    authorizeBridgeStream({ customParameters: echoed, authToken: TOKEN, required: false, nowMs: NOW }),
    { ok: true, slug: 'clinic-intake-booking', to: '+14155550123', verified: false },
  );
  assert.equal(bridgeStreamFor({ ...cfg, verifySignatures: true }, 's', '+1', NOW)!.signed, true);
});

async function withTwilioEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: TOKEN, TELEPHONY_PUBLIC_URL: 'wss://bridge.test' });
  delete process.env.TELEPHONY_PROVIDER;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { process.env = saved; }
}

const WEBHOOK = 'https://web.test/api/telephony/twilio/incoming-call';
function twilioPost(form: Record<string, string>, signature?: string) {
  return new NextRequest(WEBHOOK, {
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': signature } : {}) },
  });
}
const FORM = { CallSid: 'CA1', From: '+15550000000', To: '+14155550123' };
function twilioSign(url: string, form: Record<string, string>) {
  let data = url;
  for (const k of Object.keys(form).sort()) data += k + form[k];
  return createHmac('sha1', TOKEN).update(data).digest('base64');
}

test('R1 route-level: an unauthenticated POST gets no signature (oracle closed), verified or not', async () => {
  // Verification ON: unsigned POST is rejected outright.
  await withTwilioEnv({ TWILIO_VERIFY_SIGNATURES: 'true', TELEPHONY_PUBLIC_WEBHOOK_URL: WEBHOOK }, async () => {
    assert.equal((await incomingCall(twilioPost(FORM))).status, 403);
  });
  // Verification OFF (the pre-R2 live-call-up setup): answered, but nothing minted.
  await withTwilioEnv({ TWILIO_VERIFY_SIGNATURES: 'false', TELEPHONY_PUBLIC_WEBHOOK_URL: WEBHOOK }, async () => {
    const res = await incomingCall(twilioPost(FORM));
    assert.equal(res.status, 200);
    const echoed = paramsIn(await res.text());
    assert.equal(echoed.to, '+14155550123');
    assert.equal(echoed.sig, undefined);
    assert.equal(authorizeBridgeStream({ customParameters: echoed, authToken: TOKEN, required: true }).ok, false);
  });
});

test('R1/R2 route-level: a genuinely Twilio-signed POST at TELEPHONY_PUBLIC_WEBHOOK_URL gets a stream the bridge admits', async () => {
  await withTwilioEnv({ TWILIO_VERIFY_SIGNATURES: 'true', TELEPHONY_PUBLIC_WEBHOOK_URL: WEBHOOK }, async () => {
    const res = await incomingCall(twilioPost(FORM, twilioSign(WEBHOOK, FORM)));
    assert.equal(res.status, 200);
    const echoed = paramsIn(await res.text());
    assert.deepEqual(
      authorizeBridgeStream({ customParameters: echoed, authToken: TOKEN, required: true }),
      { ok: true, slug: 'clinic-intake-booking', to: '+14155550123', verified: true },
    );
  });
});

test('N1: a signed stream opens one call; replay → replayed; forged sigs never enter the cache', () => {
  const seen = new SeenStreamSignatures();
  const p = asRecord(signBridgeStream(TOKEN, 's', '+1', NOW));
  const gate = (cp: Record<string, string>, nowMs = NOW) => authorizeBridgeStream({ customParameters: cp, authToken: TOKEN, required: true, nowMs, seen });
  assert.equal(gate(p).ok, true);
  assert.deepEqual(gate(p, NOW + 1000), { ok: false, reason: 'replayed' });
  assert.deepEqual(gate({ ...p, sig: 'x'.repeat(p.sig.length) }), { ok: false, reason: 'bad_signature' });
  assert.equal(seen.size, 1, 'only the verified sig was recorded');
  // Expired entries are pruned on the next claim.
  const later = NOW + (BRIDGE_STREAM_TTL_SEC + 5) * 1000;
  assert.equal(gate(asRecord(signBridgeStream(TOKEN, 's', '+1', later)), later).ok, true);
  assert.equal(seen.size, 1);
});
