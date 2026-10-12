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
  } finally {
    await new Promise((r) => wss.close(r));
    console.log = origLog;
    process.env = saved;
  }
});
