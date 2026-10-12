/**
 * SAU-270 — Phase 1 · WS1 telephony ingress spike (Twilio inbound).
 *
 * Verifies the parts that DON'T need a real phone number, end-to-end:
 *  - the swappable provider seam + fail-soft factory (no creds ⇒ simulated no-op);
 *  - TwiML generation (Connect/Stream vs fail-soft) + Twilio Media Stream frames;
 *  - inbound webhook signature verification (HMAC-SHA1 round trip);
 *  - the OpenAI Realtime session config (μ-law both ways = transcode-free bridge);
 *  - the BRIDGE ORCHESTRATOR running a simulated inbound call through the real
 *    clinic tools to a booked event on the mock calendar (AC #1, offline).
 *
 * A real PSTN call additionally needs live Twilio creds + a public tunnel to the
 * bridge server — an ops/board action (see the issue), like the SAU-238/267 live
 * mic demo. Everything reachable without that is covered here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  connectStreamTwiml,
  failSoftTwiml,
  parseTwilioFrame,
  outboundMediaFrame,
  clearFrame,
  verifyTwilioSignature,
} from '@/services/telephony/twilio-protocol';
import {
  resolveTwilioConfig,
  bridgeWsUrlFor,
  bridgeServerPort,
} from '@/services/telephony/twilio-config';
import { getTelephonyAdapter, getTwilioConfig } from '@/services/telephony';
import { MockTelephonyAdapter } from '@/services/telephony/mock-telephony';
import { TwilioTelephonyAdapter } from '@/services/telephony/twilio-telephony';
import { openAiSessionUpdate, toRealtimeTool } from '@/services/telephony/openai-realtime-session';
import { startCallBridge, type MediaTransport, type RealtimeTransport } from '@/services/telephony/bridge';

import { MockCalendarAdapter } from '@/services/calendar/mock-calendar';
import { runClinicTool } from '@/services/clinic-booking';
import { DEFAULT_CLINIC } from '@/domain/clinic';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';

const DAY = 86_400_000;
function openDay9amZ(): number {
  let ms = Date.parse('2026-06-15T09:00:00Z');
  while (!DEFAULT_CLINIC.hours[new Date(ms).getUTCDay()]) ms += DAY;
  return ms;
}

/** Run `fn` with env vars set, then restore the prior values. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prior[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

// ── TwiML + Media Stream protocol ────────────────────────────────────────────

test('connectStreamTwiml bridges to the stream url and escapes it', () => {
  const xml = connectStreamTwiml('wss://example.test/telephony/bridge?slug=a&b=c');
  assert.match(xml, /<Connect><Stream url="wss:\/\/example\.test\/telephony\/bridge\?slug=a&amp;b=c" \/><\/Connect>/);
  assert.match(xml, /^<\?xml/);
});

test('failSoftTwiml speaks a notice then hangs up', () => {
  const xml = failSoftTwiml('not connected');
  assert.match(xml, /<Say>not connected<\/Say>/);
  assert.match(xml, /<Hangup\/>/);
});

test('parseTwilioFrame parses start/media/stop and rejects garbage', () => {
  const start = parseTwilioFrame(JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { callSid: 'CA1', customParameters: { slug: 'clinic-intake-booking' } } }));
  assert.equal(start?.event, 'start');
  const media = parseTwilioFrame(JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { payload: 'AAAA' } }));
  assert.equal(media?.event, 'media');
  assert.equal(parseTwilioFrame('not json'), null);
  assert.equal(parseTwilioFrame(JSON.stringify({ foo: 1 })), null);
});

test('outbound media + clear frames carry the streamSid', () => {
  assert.deepEqual(JSON.parse(outboundMediaFrame('MZ1', 'PAYLOAD')), { event: 'media', streamSid: 'MZ1', media: { payload: 'PAYLOAD' } });
  assert.deepEqual(JSON.parse(clearFrame('MZ1')), { event: 'clear', streamSid: 'MZ1' });
});

test('verifyTwilioSignature accepts a valid HMAC-SHA1 signature and rejects tampering', () => {
  const authToken = 'test_token';
  const url = 'https://app.test/api/telephony/twilio/incoming-call?slug=clinic-intake-booking';
  const params = { CallSid: 'CA123', From: '+15550001111', To: '+15557654321' };
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + (params as Record<string, string>)[k];
  const sig = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');

  assert.equal(verifyTwilioSignature({ authToken, url, params, signature: sig }), true);
  assert.equal(verifyTwilioSignature({ authToken, url, params, signature: 'bogus' }), false);
  assert.equal(verifyTwilioSignature({ authToken, url, params, signature: null }), false);
  assert.equal(verifyTwilioSignature({ authToken: 'wrong', url, params, signature: sig }), false);
});

// ── Provider seam + fail-soft factory ────────────────────────────────────────

test('factory fails soft to the mock adapter when no Twilio creds', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TELEPHONY_PROVIDER: undefined }, () => {
    const adapter = getTelephonyAdapter();
    assert.ok(adapter instanceof MockTelephonyAdapter);
    assert.equal(adapter.simulated, true);
    const answer = adapter.answerInbound({ scenarioSlug: 'clinic-intake-booking', bridgeWsUrl: '' });
    assert.equal(answer.failSoft, true);
    assert.match(answer.body, /<Hangup\/>/);
    assert.equal(adapter.verifyWebhook({ url: 'x', signature: null, params: {} }), true);
    assert.equal(resolveTwilioConfig(null), null);
    assert.equal(getTwilioConfig(), null);
  });
});

test('factory selects the live Twilio adapter when creds present; mock forces mock', async () => {
  await withEnv(
    { TWILIO_ACCOUNT_SID: 'ACxxxx', TWILIO_AUTH_TOKEN: 'tok', TWILIO_PHONE_NUMBER: '+15551234567', TELEPHONY_PROVIDER: undefined },
    () => {
      const adapter = getTelephonyAdapter();
      assert.ok(adapter instanceof TwilioTelephonyAdapter);
      assert.equal(adapter.simulated, false);
      assert.match(adapter.label, /\+15551234567/);

      const cfg = getTwilioConfig();
      assert.ok(cfg);
      assert.equal(cfg!.accountSid, 'ACxxxx');
      assert.equal(bridgeWsUrlFor({ ...cfg!, bridgePublicUrl: 'wss://t.test/' }), 'wss://t.test/telephony/bridge');
      // No public bridge URL ⇒ the live adapter still fails soft (can't stream).
      assert.equal(bridgeWsUrlFor(cfg!), null);
    },
  );
  await withEnv({ TWILIO_ACCOUNT_SID: 'ACxxxx', TWILIO_AUTH_TOKEN: 'tok', TELEPHONY_PROVIDER: 'mock' }, () => {
    assert.ok(getTelephonyAdapter() instanceof MockTelephonyAdapter);
    assert.equal(getTwilioConfig(), null);
  });
});

test('Twilio adapter: Connect/Stream with a bridge url, fail-soft without', () => {
  const cfg = { accountSid: 'AC', authToken: 'tok', verifySignatures: false };
  const adapter = new TwilioTelephonyAdapter(cfg);
  const connected = adapter.answerInbound({ scenarioSlug: 's', bridgeWsUrl: 'wss://t.test/telephony/bridge' });
  assert.equal(connected.failSoft, false);
  assert.match(connected.body, /<Connect><Stream/);
  const noBridge = adapter.answerInbound({ scenarioSlug: 's', bridgeWsUrl: '' });
  assert.equal(noBridge.failSoft, true);
  assert.match(noBridge.body, /<Hangup\/>/);
  // verifySignatures=false ⇒ trust (dev/tunnel escape hatch).
  assert.equal(adapter.verifyWebhook({ url: 'x', signature: null, params: {} }), true);
});

test('bridgeServerPort honors env and defaults to 5050', async () => {
  await withEnv({ TELEPHONY_BRIDGE_PORT: undefined }, () => assert.equal(bridgeServerPort(), 5050));
  await withEnv({ TELEPHONY_BRIDGE_PORT: '6001' }, () => assert.equal(bridgeServerPort(), 6001));
});

// ── OpenAI Realtime session config (transcode-free μ-law bridge) ──────────────

test('openAiSessionUpdate uses GA shape: audio/pcmu both ways, server VAD, and maps tools', () => {
  const upd = openAiSessionUpdate({
    instructions: 'be Robin',
    voice: 'alloy',
    tools: [{ name: 'check_availability', description: 'd', paramsSchema: { type: 'object' }, sideEffect: 'server' }],
  });
  const session = (upd as { session: Record<string, unknown> }).session;
  // GA Realtime API (SAU-293): audio nested under input/output, format is an object
  // (μ-law = audio/pcmu), output_modalities replaces top-level modalities, and the
  // old beta fields must be gone (sending them fails with beta_api_shape_disabled).
  const audio = session.audio as { input: Record<string, unknown>; output: Record<string, unknown> };
  assert.deepEqual(audio.input.format, { type: 'audio/pcmu' });
  assert.deepEqual(audio.output.format, { type: 'audio/pcmu' });
  assert.equal((audio.output as { voice: string }).voice, 'alloy');
  const td = audio.input.turn_detection as Record<string, unknown>;
  assert.equal(td.type, 'server_vad');
  // create_response is essential — without it the GA agent never replies.
  assert.equal(td.create_response, true);
  assert.deepEqual(session.output_modalities, ['audio']);
  assert.equal(session.input_audio_format, undefined);
  assert.equal(session.modalities, undefined);
  const tools = session.tools as Array<{ type: string; name: string }>;
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].name, 'check_availability');
});

test('toRealtimeTool maps the compiled tool shape', () => {
  const t = toRealtimeTool({ name: 'create_appointment', description: 'book', paramsSchema: { type: 'object', properties: {} }, sideEffect: 'server' });
  assert.deepEqual(t, { type: 'function', name: 'create_appointment', description: 'book', parameters: { type: 'object', properties: {} } });
});

// ── Bridge orchestrator: a simulated inbound call books on the mock calendar ──

class FakeMedia implements MediaTransport {
  readonly label = 'fake-media';
  sent: string[] = [];
  cleared = 0;
  closed = false;
  private audioCb: (b: string) => void = () => {};
  private closeCb: () => void = () => {};
  onAudio(cb: (b: string) => void) { this.audioCb = cb; }
  onClose(cb: () => void) { this.closeCb = cb; }
  sendAudio(b: string) { this.sent.push(b); }
  clear() { this.cleared++; }
  close() { this.closed = true; }
  emitAudio(b: string) { this.audioCb(b); }
  emitClose() { this.closeCb(); }
}

class FakeRealtime implements RealtimeTransport {
  readonly vendor = 'openai';
  appended: string[] = [];
  toolResults: Array<{ callId: string; output: unknown }> = [];
  started = false;
  closed = false;
  private audioDeltaCb: (b: string) => void = () => {};
  private speechCb: () => void = () => {};
  private fnCb: (c: { callId: string; name: string; argsJson: string }) => void | Promise<void> = () => {};
  private transcriptCb: (t: { role: 'user' | 'agent'; text: string }) => void = () => {};
  private closeCb: () => void = () => {};
  start() { this.started = true; return Promise.resolve(); }
  appendAudio(b: string) { this.appended.push(b); }
  sendToolResult(callId: string, output: unknown) { this.toolResults.push({ callId, output }); }
  onAudioDelta(cb: (b: string) => void) { this.audioDeltaCb = cb; }
  onSpeechStarted(cb: () => void) { this.speechCb = cb; }
  onFunctionCall(cb: (c: { callId: string; name: string; argsJson: string }) => void | Promise<void>) { this.fnCb = cb; }
  onTranscript(cb: (t: { role: 'user' | 'agent'; text: string }) => void) { this.transcriptCb = cb; }
  onError() {}
  onClose(cb: () => void) { this.closeCb = cb; }
  close() { this.closed = true; }
  emitAudioDelta(b: string) { this.audioDeltaCb(b); }
  emitSpeech() { this.speechCb(); }
  async emitFn(c: { callId: string; name: string; argsJson: string }) { await this.fnCb(c); }
  emitTranscript(t: { role: 'user' | 'agent'; text: string }) { this.transcriptCb(t); }
  emitClose() { this.closeCb(); }
}

test('bridge orchestrator runs an inbound call → intake → booked outcome (offline)', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(
    store,
    `---\nid: tel-clinic\nname: Tel Clinic\npersona: be Robin\nvisibility: public\ntools: [check_availability, create_appointment]\n---\n`,
    { repoPath: 'tel.md', revision: null },
  );
  const session = await store.createSession({ scenarioId: scenario.id, userId: null, vendor: 'openai' });

  // Deterministic clinic clock + a shared mock calendar so the booking sticks.
  const calendar = new MockCalendarAdapter();
  const nowMs = openDay9amZ();
  const runTool = (name: string, argsJson: string) => runClinicTool(name, JSON.parse(argsJson), { calendar, nowMs });

  const media = new FakeMedia();
  const realtime = new FakeRealtime();
  const bridge = await startCallBridge(media, realtime, { scenario, store, sessionId: session.id, runTool, now: () => nowMs });
  assert.equal(realtime.started, true);

  // Caller audio is forwarded to the model; the model's audio is forwarded back.
  media.emitAudio('CALLER_ULAW');
  assert.deepEqual(realtime.appended, ['CALLER_ULAW']);
  realtime.emitAudioDelta('AGENT_ULAW');
  assert.deepEqual(media.sent, ['AGENT_ULAW']);

  // Barge-in: caller talks over the agent → outbound buffer is flushed.
  realtime.emitSpeech();
  assert.equal(media.cleared, 1);

  realtime.emitTranscript({ role: 'agent', text: 'Hi, this is Robin at Riverside.' });
  realtime.emitTranscript({ role: 'user', text: 'I am Jordan Patel, I have Aetna, I need to see Dr Chen for a cough.' });

  // Tool 1: the agent checks availability (rules enforced in the executor).
  await realtime.emitFn({ callId: 'call-1', name: 'check_availability', argsJson: JSON.stringify({ doctor: 'dr-chen' }) });
  const check = bridge.transcript.toolCalls[0].result as { slots: Array<{ doctorId: string; start: string }> };
  assert.ok(check.slots.length > 0);
  assert.equal(realtime.toolResults[0].callId, 'call-1');
  const slot = check.slots[0];

  // Tool 2: the agent books the confirmed slot → real event id on the mock calendar.
  await realtime.emitFn({
    callId: 'call-2',
    name: 'create_appointment',
    argsJson: JSON.stringify({ patientName: 'Jordan Patel', doctor: slot.doctorId, slotStart: slot.start, reason: 'cough', insurance: 'Aetna' }),
  });
  const booked = bridge.transcript.toolCalls[1].result as { booked: boolean; eventId?: string };
  assert.equal(booked.booked, true);
  assert.ok(booked.eventId);

  // Hang up → finalize exactly once: outcome + intake persisted (reusing SAU-267).
  media.emitClose();
  await new Promise((r) => setImmediate(r));
  assert.equal(bridge.finalized, true);
  assert.equal(media.closed, true);
  assert.equal(realtime.closed, true);

  const outcome = await store.getClinicOutcome(session.id);
  assert.equal(outcome?.outcome, 'booked');
  assert.equal(outcome?.eventId, booked.eventId);
  assert.equal((outcome?.intake as { patientName?: string }).patientName, 'Jordan Patel');
});

test('bridge finalizes only once even if both transports close', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(
    store,
    `---\nid: tel-clinic-2\nname: Tel2\npersona: be Robin\nvisibility: public\ntools: [check_availability, create_appointment]\n---\n`,
    { repoPath: 'tel2.md', revision: null },
  );
  const session = await store.createSession({ scenarioId: scenario.id, userId: null, vendor: 'openai' });
  const media = new FakeMedia();
  const realtime = new FakeRealtime();
  let finalizeCount = 0;
  const bridge = await startCallBridge(media, realtime, {
    scenario,
    store,
    sessionId: session.id,
    log: (e) => { if (e === 'finalized') finalizeCount++; },
  });
  media.emitClose();
  realtime.emitClose();
  await new Promise((r) => setImmediate(r));
  assert.equal(bridge.finalized, true);
  assert.equal(finalizeCount, 1);
});
