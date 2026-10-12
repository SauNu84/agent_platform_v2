/**
 * SAU-525 — inbound-call admission: tenant → payer → cap → engine, fail-closed.
 * Offline over MemoryStore; the RLS leg (system actor clears the clinic policy
 * under app_rw) is in tests/call-admission-rls.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { getActorContext } from '@/auth/actor';
import {
  admitInboundCall, CallAdmissionError, normalizeDialedNumber, BRIDGE_SYSTEM_ACTOR,
} from '@/services/telephony/call-admission';
import { resolveTenantEngine } from '@/voice/engine-router';
import { setClinicTelephony, TenancyError, getClinicSwitcherView } from '@/services/clinic-tenancy';
import { bridgeStreamFor, type TwilioConfig } from '@/services/telephony/twilio-config';
import { startCallBridge, type MediaTransport, type RealtimeTransport, type CallSummary } from '@/services/telephony/bridge';
import { createScenarioFromMarkdown } from '@/services/scenarios';

const NUMBER = '+14155550123';

async function clinicWithOwner(store: MemoryStore, opts: { slug?: string; phone?: string | null; engine?: 'standard' | 'premium' | null; owner?: string } = {}) {
  const owner = opts.owner ?? 'owner-1';
  const clinic = await store.createClinic({
    slug: opts.slug ?? 'riverside', name: 'Riverside', createdByUserId: owner,
    phoneNumber: opts.phone === undefined ? NUMBER : opts.phone, voiceEngine: opts.engine ?? null,
  });
  await store.addClinicMember(clinic.id, owner, 'owner');
  return { clinic, owner };
}

test('normalizeDialedNumber: tolerates formatting, rejects garbage', () => {
  assert.equal(normalizeDialedNumber('+1 (415) 555-0123'), '+14155550123');
  // a bare national number is NOT promoted — "+4155550123" would be a Swiss number
  assert.equal(normalizeDialedNumber('14155550123'), null);
  assert.equal(normalizeDialedNumber('(415) 555-0123'), null);
  assert.equal(normalizeDialedNumber(' +14155550123 '), '+14155550123');
  assert.equal(normalizeDialedNumber('+0123456'), null);
  assert.equal(normalizeDialedNumber('client:anonymous'), null);
  assert.equal(normalizeDialedNumber(''), null);
  assert.equal(normalizeDialedNumber(null), null);
});

test('admits a bound number: owner is the payer, call is scoped to the tenant, engine defaults to standard (mini)', async () => {
  const store = new MemoryStore();
  const { clinic, owner } = await clinicWithOwner(store);
  const a = await admitInboundCall(store, { to: '+1 (415) 555-0123' });
  assert.equal(a.clinic.id, clinic.id);
  assert.equal(a.ownerUserId, owner);
  assert.equal(a.resolvedBy, 'phone_number');
  assert.deepEqual(a.actor, { userId: owner, isAdmin: false, clinicId: clinic.id });
  assert.equal(a.tier, 'free'); // no entitlement row ⇒ free payer
  assert.equal(a.engine.grade, 'standard');
  assert.equal(a.engine.model, process.env.VOICE_ENGINE_FREE || 'gpt-realtime-2.1-mini');
  assert.equal(a.engine.vendor, 'openai');
  assert.equal(a.meter.overCap, false);
  // the privileged lookup context never leaks out of admission
  assert.equal(getActorContext(), undefined);
});

test('a PAID clinic still runs standard (mini) unless bound to premium — the SAU-455 margin case', async () => {
  const store = new MemoryStore();
  const { clinic, owner } = await clinicWithOwner(store);
  await store.upsertEntitlement({ userId: owner, plan: 'paid', freeMinutes: 30, paidMinutes: 1000, planTier: 'standard' });

  const a = await admitInboundCall(store, { to: NUMBER });
  assert.equal(a.tier, 'paid', 'metered at the payer\'s billing tier');
  assert.equal(a.engine.grade, 'standard', 'engine grade is the tenant\'s, not the plan\'s');
  assert.equal(a.engine.model, process.env.VOICE_ENGINE_FREE || 'gpt-realtime-2.1-mini');

  await store.updateClinicTelephony(clinic.id, { voiceEngine: 'premium' });
  const b = await admitInboundCall(store, { to: NUMBER });
  assert.equal(b.engine.grade, 'premium');
  assert.equal(b.engine.model, process.env.VOICE_ENGINE_PAID || process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime');
});

test('premium is paid-only: a free-tier payer bound to premium is downgraded to standard', async () => {
  const store = new MemoryStore();
  await clinicWithOwner(store, { engine: 'premium' });
  const a = await admitInboundCall(store, { to: NUMBER });
  assert.equal(a.tier, 'free');
  assert.equal(a.engine.grade, 'standard');
  assert.equal(a.engine.model, process.env.VOICE_ENGINE_FREE || 'gpt-realtime-2.1-mini', 'runs the standard model, never premium');
});

test('refuses an unbound number (no_tenant) — never falls back to an unmetered call', async () => {
  const store = new MemoryStore();
  await clinicWithOwner(store);
  await assert.rejects(admitInboundCall(store, { to: '+14155559999' }), (e: unknown) => {
    assert.ok(e instanceof CallAdmissionError);
    assert.equal(e.reason, 'no_tenant');
    return true;
  });
});

test('refuses a call with no dialed number (no_number) unless a fallback tenant is configured', async () => {
  const store = new MemoryStore();
  await clinicWithOwner(store, { slug: 'trial' });
  await assert.rejects(admitInboundCall(store, { to: null }), (e: unknown) => e instanceof CallAdmissionError && e.reason === 'no_number');
  await assert.rejects(admitInboundCall(store, { to: 'client:anon' }), (e: unknown) => e instanceof CallAdmissionError && e.reason === 'no_number');
});

test('fallback clinic slug admits an unbound number but is STILL metered to that clinic\'s owner', async () => {
  const store = new MemoryStore();
  const { clinic, owner } = await clinicWithOwner(store, { slug: 'trial', phone: null });
  const a = await admitInboundCall(store, { to: '+14155559999', fallbackClinicSlug: 'trial' });
  assert.equal(a.resolvedBy, 'fallback_slug');
  assert.equal(a.clinic.id, clinic.id);
  assert.equal(a.ownerUserId, owner);
  // a bound number wins over the fallback
  const { clinic: bound } = await clinicWithOwner(store, { slug: 'bound', owner: 'owner-2' });
  const b = await admitInboundCall(store, { to: NUMBER, fallbackClinicSlug: 'trial' });
  assert.equal(b.clinic.id, bound.id);
  assert.equal(b.resolvedBy, 'phone_number');
  // an unknown fallback slug is not a route around the meter either
  await assert.rejects(admitInboundCall(store, { to: '+14155559999', fallbackClinicSlug: 'nope' }), (e: unknown) => e instanceof CallAdmissionError && e.reason === 'no_tenant');
});

test('refuses a tenant with nobody to bill (no_owner)', async () => {
  const store = new MemoryStore();
  await store.createClinic({ slug: 'orphan', name: 'Orphan', createdByUserId: '', phoneNumber: NUMBER });
  await assert.rejects(admitInboundCall(store, { to: NUMBER }), (e: unknown) => e instanceof CallAdmissionError && e.reason === 'no_owner');
});

test('owner falls back to the earliest owner-role member when the creator is unknown', async () => {
  const store = new MemoryStore();
  const clinic = await store.createClinic({ slug: 'legacy', name: 'Legacy', createdByUserId: '', phoneNumber: NUMBER });
  await store.addClinicMember(clinic.id, 'staff-1', 'staff');
  await store.addClinicMember(clinic.id, 'owner-9', 'owner');
  const a = await admitInboundCall(store, { to: NUMBER });
  assert.equal(a.ownerUserId, 'owner-9');
});

test('CTO condition: a creator who is no longer an owner member is never charged — falls through to the earliest owner', async () => {
  const store = new MemoryStore();
  // creator 'founder' left the clinic (never/no longer a member); 'owner-2' is the current owner
  const clinic = await store.createClinic({ slug: 'moved', name: 'Moved', createdByUserId: 'founder', phoneNumber: NUMBER });
  await store.addClinicMember(clinic.id, 'owner-2', 'owner');
  // the ex-member's own cap is spent — it must not refuse the clinic's call
  await store.upsertEntitlement({ userId: 'founder', plan: 'free', freeMinutes: 0, paidMinutes: 0, planTier: 'free' });
  const a = await admitInboundCall(store, { to: NUMBER });
  assert.equal(a.ownerUserId, 'owner-2');
  assert.equal(a.meter.userId, 'owner-2', 'the pre-flight cap is the current owner\'s, not the ex-member\'s');
  assert.equal(a.payerResolvedBy, 'earliest_owner');
  assert.equal(a.actor.userId, 'owner-2', 'usage rows are attributed to the current owner');
});

test('CTO condition: a creator downgraded out of the owner role is skipped', async () => {
  const store = new MemoryStore();
  const clinic = await store.createClinic({ slug: 'demoted', name: 'Demoted', createdByUserId: 'founder', phoneNumber: NUMBER });
  await store.addClinicMember(clinic.id, 'founder', 'staff');
  await store.addClinicMember(clinic.id, 'owner-3', 'owner');
  const a = await admitInboundCall(store, { to: NUMBER });
  assert.equal(a.ownerUserId, 'owner-3');
  assert.equal(a.payerResolvedBy, 'earliest_owner');
});

test('CTO condition: a creator who left with no other owner ⇒ refused (no_owner), not billed to the ex-member', async () => {
  const store = new MemoryStore();
  const clinic = await store.createClinic({ slug: 'abandoned', name: 'Abandoned', createdByUserId: 'founder', phoneNumber: NUMBER });
  await store.addClinicMember(clinic.id, 'staff-1', 'staff');
  await assert.rejects(admitInboundCall(store, { to: NUMBER }), (e: unknown) => e instanceof CallAdmissionError && e.reason === 'no_owner');
});

test('a creator who is still an owner member is the payer', async () => {
  const store = new MemoryStore();
  const { owner } = await clinicWithOwner(store);
  // a later co-owner does not displace the creator
  await store.addClinicMember((await store.getClinicByPhoneNumber(NUMBER))!.id, 'co-owner', 'owner');
  const a = await admitInboundCall(store, { to: NUMBER });
  assert.equal(a.ownerUserId, owner);
  assert.equal(a.payerResolvedBy, 'creator');
});

test('refuses when the owner has spent this month\'s minutes (cap_exceeded) — same pre-flight as the web Join', async () => {
  const store = new MemoryStore();
  const { owner } = await clinicWithOwner(store);
  await store.upsertEntitlement({ userId: owner, plan: 'free', freeMinutes: 5, paidMinutes: 0, planTier: 'free' });
  const { scenario } = await createScenarioFromMarkdown(store, `---\nid: cap-scn\nname: Cap\npersona: coach\nvisibility: public\n---\n`);
  const s = await store.createSession({ scenarioId: scenario.id, userId: owner, vendor: 'openai' });
  await store.recordVoiceUsage({
    sessionId: s.id, userId: owner, scenarioId: scenario.id, vendor: 'openai', model: 'gpt-realtime-mini',
    durationMs: 6 * 60_000, voiceMinutes: 6,
    inputTextTokens: 0, inputAudioTokens: 0, cachedTextTokens: 0, cachedAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0, totalTokens: 0,
  });
  await assert.rejects(admitInboundCall(store, { to: NUMBER }), (e: unknown) => {
    assert.ok(e instanceof CallAdmissionError);
    assert.equal(e.reason, 'cap_exceeded');
    assert.equal(e.meter?.overCap, true);
    return true;
  });
});

test('resolveTenantEngine: tenant levers point the clinic path at a different model without moving web users', () => {
  const prev = { s: process.env.VOICE_ENGINE_TENANT_STANDARD, p: process.env.VOICE_ENGINE_TENANT_PREMIUM };
  try {
    process.env.VOICE_ENGINE_TENANT_STANDARD = 'gpt-realtime-2.1-mini';
    process.env.VOICE_ENGINE_TENANT_PREMIUM = 'gpt-realtime-2.1';
    assert.equal(resolveTenantEngine({ tier: 'paid', grade: null }).model, 'gpt-realtime-2.1-mini');
    assert.equal(resolveTenantEngine({ tier: 'paid', grade: 'premium' }).model, 'gpt-realtime-2.1');
    assert.equal(resolveTenantEngine({ tier: 'free', grade: 'premium' }).model, 'gpt-realtime-2.1-mini', 'premium gated to paid');
    // a Gemini-authored scenario is a cost engine on every grade; tenant levers are OpenAI-only
    assert.equal(resolveTenantEngine({ modelId: 'google-gemini', tier: 'paid', grade: 'premium' }).vendor, 'gemini');
  } finally {
    if (prev.s === undefined) delete process.env.VOICE_ENGINE_TENANT_STANDARD; else process.env.VOICE_ENGINE_TENANT_STANDARD = prev.s;
    if (prev.p === undefined) delete process.env.VOICE_ENGINE_TENANT_PREMIUM; else process.env.VOICE_ENGINE_TENANT_PREMIUM = prev.p;
  }
});

test('BRIDGE_SYSTEM_ACTOR is admin-scoped with a nil user (matches no owner row)', () => {
  assert.equal(BRIDGE_SYSTEM_ACTOR.isAdmin, true);
  assert.equal(BRIDGE_SYSTEM_ACTOR.userId, '00000000-0000-0000-0000-000000000000');
  assert.equal(BRIDGE_SYSTEM_ACTOR.clinicId, null);
});

// ── binding API (service layer) ───────────────────────────────────────────────

test('setClinicTelephony: members set the engine grade; only a platform admin binds the number', async () => {
  const store = new MemoryStore();
  const { clinic, owner } = await clinicWithOwner(store, { phone: null });
  const member = { userId: owner, isAdmin: false };
  const admin = { userId: owner, isAdmin: true };

  const c1 = await setClinicTelephony(store, member, clinic.id, { voiceEngine: 'premium' });
  assert.equal(c1.voiceEngine, 'premium');
  assert.equal(c1.phoneNumber, null);

  await assert.rejects(setClinicTelephony(store, member, clinic.id, { phoneNumber: NUMBER }), (e: unknown) => e instanceof TenancyError && e.status === 403);
  await assert.rejects(setClinicTelephony(store, member, clinic.id, { voiceEngine: 'turbo' }), (e: unknown) => e instanceof TenancyError && e.status === 400);
  await assert.rejects(setClinicTelephony(store, { userId: 'stranger', isAdmin: true }, clinic.id, { phoneNumber: NUMBER }), (e: unknown) => e instanceof TenancyError && e.status === 403);
  await assert.rejects(setClinicTelephony(store, admin, clinic.id, { phoneNumber: 'not a number' }), (e: unknown) => e instanceof TenancyError && e.status === 400);

  await assert.rejects(setClinicTelephony(store, admin, clinic.id, { phoneNumber: '(415) 555-0123' }), (e: unknown) => e instanceof TenancyError && e.status === 400, 'no country code ⇒ rejected, never guessed');
  const c2 = await setClinicTelephony(store, admin, clinic.id, { phoneNumber: '+1 (415) 555-0123' });
  assert.equal(c2.phoneNumber, '+14155550123', 'normalized to E.164');
  assert.equal(c2.voiceEngine, 'premium', 'untouched field is preserved');

  // one number ⇒ one tenant
  const { clinic: other, owner: owner2 } = await clinicWithOwner(store, { slug: 'other', phone: null, owner: 'owner-2' });
  await assert.rejects(setClinicTelephony(store, { userId: owner2, isAdmin: true }, other.id, { phoneNumber: NUMBER }), (e: unknown) => e instanceof TenancyError && e.status === 409);

  // clear both
  const c3 = await setClinicTelephony(store, admin, clinic.id, { phoneNumber: null, voiceEngine: null });
  assert.equal(c3.phoneNumber, null);
  assert.equal(c3.voiceEngine, null);

  // the switcher view surfaces the binding
  await setClinicTelephony(store, admin, clinic.id, { phoneNumber: NUMBER, voiceEngine: 'standard' });
  const view = await getClinicSwitcherView(store, owner, clinic.id);
  assert.deepEqual(view.clinics.map((c) => [c.phoneNumber, c.voiceEngine]), [[NUMBER, 'standard']]);
});

test('bridgeStreamFor carries the dialed number to the bridge as a signed <Parameter>, not ?to=', () => {
  const cfg: TwilioConfig = { accountSid: 'AC', authToken: 't', bridgePublicUrl: 'wss://t.test/', verifySignatures: true };
  const s = bridgeStreamFor(cfg, 'clinic-intake-booking', '+14155550123');
  // Twilio's <Stream url> does not support query strings (SAU-541) — the URL is bare.
  assert.equal(s?.url, 'wss://t.test/telephony/bridge');
  assert.equal(s?.parameters.slug, 'clinic-intake-booking');
  assert.equal(s?.parameters.to, '+14155550123');
  assert.equal(bridgeStreamFor(cfg, 'clinic-intake-booking')?.parameters.to, '', 'back-compat without a number');
  assert.equal(bridgeStreamFor({ ...cfg, bridgePublicUrl: undefined }, 'x', '+1'), null);
});

// ── bridge: actor binding + metering hook ────────────────────────────────────

class FakeMedia implements MediaTransport {
  readonly label = 'fake';
  private closeCb: () => void = () => {};
  onAudio() {}
  onClose(cb: () => void) { this.closeCb = cb; }
  sendAudio() {}
  clear() {}
  close() {}
  emitClose() { this.closeCb(); }
}
class FakeRealtime implements RealtimeTransport {
  readonly vendor = 'openai';
  private fnCb: (c: { callId: string; name: string; argsJson: string }) => void | Promise<void> = () => {};
  start() { return Promise.resolve(); }
  appendAudio() {}
  sendToolResult() {}
  onAudioDelta() {}
  onSpeechStarted() {}
  onFunctionCall(cb: (c: { callId: string; name: string; argsJson: string }) => void | Promise<void>) { this.fnCb = cb; }
  onTranscript() {}
  onError() {}
  onClose() {}
  close() {}
  usage() { return { inputTextTokens: 10, inputAudioTokens: 200, cachedTextTokens: 5, cachedAudioTokens: 0, outputTextTokens: 20, outputAudioTokens: 300, totalTokens: 530 }; }
  async emitFn(c: { callId: string; name: string; argsJson: string }) { await this.fnCb(c); }
}

test('bridge re-enters the tenant actor for tool calls + finalize, and hands the metering hook duration + measured usage', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, `---\nid: meter-scn\nname: M\npersona: coach\nvisibility: public\n---\n`);
  const actor = { userId: 'owner-1', isAdmin: false, clinicId: 'clinic-1' };
  let t = 1_000_000;
  const seenInTool: unknown[] = [];
  let seenInFinalize: unknown = 'unset';
  let summary: CallSummary | null = null;

  const media = new FakeMedia();
  const realtime = new FakeRealtime();
  await startCallBridge(media, realtime, {
    scenario, store, actor, now: () => t,
    runTool: async () => { seenInTool.push(getActorContext()); return { ok: true }; },
    onFinalize: async (s) => { seenInFinalize = getActorContext(); summary = s; },
  });
  // Socket events fire OUTSIDE any actor scope — the bridge must bind it itself.
  assert.equal(getActorContext(), undefined);
  await realtime.emitFn({ callId: 'c1', name: 'noop', argsJson: '{}' });
  assert.deepEqual(seenInTool, [actor]);

  t += 90_000; // 1.5 min call
  media.emitClose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seenInFinalize, actor);
  const got = summary as CallSummary | null;
  assert.ok(got);
  assert.equal(got.endedAt - got.startedAt, 90_000);
  assert.equal(got.usage?.totalTokens, 530);
  assert.equal(got.transcript.toolCalls.length, 1);
});
