/**
 * SAU-557 — paid-tier packaging behind ONE seam (`planFeatures`), with the CISO's
 * SAU-558 release conditions for memory and the CTO's engine-notice coupling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { createCoachFromMarkdown } from '@/services/coaches';
import { runCoachSession } from '@/voice/coach-session';
import { recordConsentChange } from '@/coach/consent';
import { planFeatures, resolvePlanTier, resolvePlanTierForUser } from '@/voice/plan-features';
import { coachMemoryAccess } from '@/voice/coach-memory-access';
import { viewCoachMemory, deleteCoachMemoryFor, latestExpiry } from '@/services/coach-memory-controls';
import { csvExportLockFor } from '@/services/paywall';
import { normalizeUpgradeTrigger } from '@/domain/upgrade-trigger';
import { PRODUCT_EVENTS } from '@/domain/analytics-events';
import { startCheckout, confirmCheckout } from '@/services/billing/subscription';
import { PLANS, getPlan } from '@/services/billing/plans';
import { DEFAULT_FREE_SESSION_MAX, DEFAULT_PAID_SESSION_MAX } from '@/voice/voice-policy';
import { getMeterState } from '@/services/meter';
import { resolveTenantEngine } from '@/voice/engine-router';
import type { Transcript } from '@/voice/realtime-interface';

const SCENARIO_MD = `---\nid: pitch-practice\nname: Pitch Practice\npersona: You are a tough Series A investor.\nvisibility: public\n---\n`;
const COACH_MD = `---\nid: pitch-coach\nname: Pitch Coach\nscenario_ref: pitch-practice\nretention: persistent\nschedule:\n  cadence: weekly\n---\n`;
const USER = '00000000-0000-4000-8000-0000000005a7';

const say = (text: string): Transcript => ({
  sessionId: 't', turns: [{ role: 'user', text, at: 1 }, { role: 'agent', text: 'Noted.', at: 2 }], toolCalls: [], startedAt: 1, endedAt: 1000,
});

async function setPlan(store: MemoryStore, tier: 'free' | 'standard' | 'premium') {
  await store.upsertEntitlement({ userId: USER, plan: tier === 'free' ? 'free' : 'paid', freeMinutes: 30, paidMinutes: tier === 'free' ? 0 : 73, planTier: tier });
}

/** A premium user with consent who has built up memories with the coach. */
async function premiumUserWithMemories() {
  const store = new MemoryStore();
  await createScenarioFromMarkdown(store, SCENARIO_MD);
  const { coach } = await createCoachFromMarkdown(store, COACH_MD);
  const scenario = (await store.getScenarioById(coach.scenarioId!))!;
  await recordConsentChange({ store, userId: USER, coachId: coach.id, consentType: 'persistent_memory', action: 'granted' });
  await setPlan(store, 'premium');
  const r = await runCoachSession({
    store, coach, scenario, vendor: 'mock', userId: USER, planTier: 'premium',
    transcript: say('I am preparing for a Series A pitch. My goal is to close by March.'),
  });
  assert.ok(r.wroteMemories >= 1);
  return { store, coach, scenario };
}

const expiries = async (store: MemoryStore, coachId: string) =>
  (await store.listCoachMemory(coachId, USER)).map((m) => `${m.id}:${m.expiresAt}`).sort();

// ── the seam ──────────────────────────────────────────────────────────────────
test('planFeatures is the one table: memory + CSV export are Premium; unknown tier ⇒ free', () => {
  assert.deepEqual(planFeatures('free'), { coachMemory: false, csvExport: false });
  assert.deepEqual(planFeatures('standard'), { coachMemory: false, csvExport: false });
  assert.deepEqual(planFeatures('premium'), { coachMemory: true, csvExport: true });
  assert.equal(resolvePlanTier('enterprise'), 'free');
  assert.deepEqual(planFeatures(undefined), planFeatures('free'));
});

test('coachMemoryAccess = plan AND consent, evaluated in one place', async () => {
  const { store, coach } = await premiumUserWithMemories();
  assert.equal(await coachMemoryAccess(store, { userId: USER, coachId: coach.id, planTier: 'premium' }), 'active');
  assert.equal(await coachMemoryAccess(store, { userId: USER, coachId: coach.id, planTier: 'standard' }), 'paused');
  assert.equal(await coachMemoryAccess(store, { userId: null, coachId: coach.id, planTier: 'premium' }), 'anonymous');
  await recordConsentChange({ store, userId: USER, coachId: coach.id, consentType: 'persistent_memory', action: 'revoked' });
  assert.equal(await coachMemoryAccess(store, { userId: USER, coachId: coach.id, planTier: 'premium' }), 'no_consent');
});

// ── CISO C2: paused / revoked ⇒ no retrieval, no expiry bump, no write ──────────
test('C2: a downgraded (paused) user gets no retrieval, no expiry bump and no write; nothing is deleted', async () => {
  const { store, coach, scenario } = await premiumUserWithMemories();
  const before = await expiries(store, coach.id);
  await setPlan(store, 'free');

  const r = await runCoachSession({
    store, coach, scenario, vendor: 'mock', userId: USER, planTier: await resolvePlanTierForUser(store, USER),
    transcript: say('I prefer blunt feedback. My goal is to raise 5 million.'),
    nowMs: Date.now() + 30 * 86_400_000, // a month later: a bump would be visible
  });
  assert.equal(r.memoryAccess, 'paused');
  assert.equal(r.injectedMemories.length, 0, 'no retrieval');
  assert.doesNotMatch(r.injectedInstructions, /What you remember/);
  assert.equal(r.wroteMemories, 0, 'no write');
  assert.match(r.memorySkippedReason ?? '', /paused/);
  assert.deepEqual(await expiries(store, coach.id), before, 'no expiry bump, nothing deleted');
});

test('C2: revoked consent + keep on a memory plan ⇒ no injection and no bump (the pre-557 bug)', async () => {
  const { store, coach, scenario } = await premiumUserWithMemories();
  const before = await expiries(store, coach.id);
  await recordConsentChange({ store, userId: USER, coachId: coach.id, consentType: 'persistent_memory', action: 'revoked' });

  const r = await runCoachSession({ store, coach, scenario, vendor: 'mock', userId: USER, planTier: 'premium', nowMs: Date.now() + 30 * 86_400_000 });
  assert.equal(r.memoryAccess, 'no_consent');
  assert.equal(r.injectedMemories.length, 0);
  assert.deepEqual(await expiries(store, coach.id), before);
  const recalled = await store.queryProductEvents({ events: [PRODUCT_EVENTS.COACH_MEMORY_RECALLED] });
  assert.equal(recalled.length, 0, 'coach_memory.recalled only fires on a real recall');
});

// ── CISO C3: re-upgrade doesn't touch expires_at; continuity returns via retrieval ─
test('C3: re-upgrading through checkout leaves expires_at untouched; the next session recalls again', async () => {
  const { store, coach, scenario } = await premiumUserWithMemories();
  await setPlan(store, 'free');
  const before = await expiries(store, coach.id);

  const { checkoutId } = await startCheckout(store, USER, 'premium', 'monthly', 'http://localhost');
  await confirmCheckout(store, checkoutId);
  assert.equal(await resolvePlanTierForUser(store, USER), 'premium');
  assert.deepEqual(await expiries(store, coach.id), before, 'payment does not refresh expiry');

  const r = await runCoachSession({ store, coach, scenario, vendor: 'mock', userId: USER, planTier: await resolvePlanTierForUser(store, USER) });
  assert.equal(r.memoryAccess, 'active');
  assert.ok(r.injectedMemories.length >= 1, 'continuity resumes through normal retrieval');
  const recalled = await store.queryProductEvents({ events: [PRODUCT_EVENTS.COACH_MEMORY_RECALLED] });
  assert.equal(recalled.at(-1)?.props?.count, r.injectedMemories.length);
});

// ── CISO C4 + C5: DSAR controls on every tier; paused state carries the real date ─
test('C4/C5: a Free user can view/export and delete; the view reports paused + the real max(expires_at)', async () => {
  const { store, coach } = await premiumUserWithMemories();
  await setPlan(store, 'free');
  const held = await store.listCoachMemory(coach.id, USER);

  const view = await viewCoachMemory(store, USER, coach);
  assert.equal(view.memories.length, held.length, 'Free can export everything held');
  assert.ok(view.memories.every((m) => !('embedding' in m)), 'export omits the embedding');
  assert.equal(view.access, 'paused');
  assert.equal(view.pausedUntil, latestExpiry(held));
  assert.equal(view.pausedUntil, new Date(Math.max(...held.map((m) => Date.parse(m.expiresAt)))).toISOString());

  const one = held[0];
  assert.deepEqual(await deleteCoachMemoryFor(store, USER, coach, one.id), { deleted: 1, found: true });
  const wiped = await deleteCoachMemoryFor(store, USER, coach);
  assert.equal(wiped.deleted, held.length - 1, 'Free can delete everything ("Delete my memories now")');
  assert.equal((await store.listCoachMemory(coach.id, USER)).length, 0);

  const audit = (await store.listAuditEvents(USER)).map((e) => e.event);
  assert.ok(audit.includes('export') && audit.filter((e) => e === 'memory.delete').length === 2, 'every DSAR action audited');
  // Not paused ⇒ no expiry date is claimed.
  await setPlan(store, 'premium');
  assert.equal((await viewCoachMemory(store, USER, coach)).pausedUntil, null);
});

// ── item 3: CSV export is Premium; the lock is a paywall.viewed ─────────────────
test('CSV export: locked below Premium (paywall.viewed recorded), open on Premium', async () => {
  const store = new MemoryStore();
  for (const tier of ['free', 'standard'] as const) {
    await setPlan(store, tier);
    assert.equal(await csvExportLockFor(store, USER), '/billing?trigger=csv_export', tier);
  }
  await setPlan(store, 'premium');
  assert.equal(await csvExportLockFor(store, USER), null);
  const viewed = await store.queryProductEvents({ events: [PRODUCT_EVENTS.PAYWALL_VIEWED] });
  assert.deepEqual(viewed.map((e) => e.props?.feature), ['csv_export', 'csv_export']);
});

test('upgrade.started trigger: feature locks, cap, and a safe default', () => {
  assert.equal(normalizeUpgradeTrigger('csv_export'), 'feature_lock:csv_export');
  assert.equal(normalizeUpgradeTrigger('feature_lock:coach_memory'), 'feature_lock:coach_memory');
  assert.equal(normalizeUpgradeTrigger('cap_reached'), 'cap_reached');
  for (const raw of [null, undefined, '', 'feature_lock:everything', 'you@example.com']) {
    assert.equal(normalizeUpgradeTrigger(raw), 'billing_page');
  }
});

// ── item 4: copy is true; the engine notice follows the configured engines ──────
test('plan copy: no claims without code behind them; gated lines derive from planFeatures', () => {
  const all = PLANS.flatMap((p) => p.features).join(' | ');
  assert.doesNotMatch(all, /Priority support|Every scenario category|analytics & scoring/i);
  assert.ok(getPlan('free')!.features.includes(`Sessions up to ${DEFAULT_FREE_SESSION_MAX} min`));
  for (const id of ['standard', 'premium']) {
    assert.ok(getPlan(id)!.features.includes(`Longer sessions — up to ${DEFAULT_PAID_SESSION_MAX} min each`), id);
  }
  const memoryLine = (id: string) => getPlan(id)!.features.includes('Coaches with persistent memory');
  const csvLine = (id: string) => getPlan(id)!.features.some((f) => /CSV export/.test(f));
  for (const id of ['free', 'standard', 'premium'] as const) {
    assert.equal(memoryLine(id), planFeatures(id).coachMemory, `${id} memory copy matches the gate`);
    assert.equal(csvLine(id), planFeatures(id).csvExport, `${id} CSV copy matches the gate`);
  }
});

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

test('engine notice (CTO constraint 1): "upgrade for better quality" shows only if paid really runs a different model', async () => {
  const store = new MemoryStore();
  await setPlan(store, 'free');
  const env = { VOICE_ENGINE_FREE: undefined, VOICE_ENGINE_PAID: undefined, OPENAI_REALTIME_MODEL: undefined };
  await withEnv(env, async () => {
    assert.equal((await getMeterState(store, USER)).engineUpgradeAvailable, false, 'SAU-534: same model ⇒ no claim');
  });
  await withEnv({ ...env, VOICE_ENGINE_PAID: 'gpt-realtime' }, async () => {
    assert.equal((await getMeterState(store, USER)).engineUpgradeAvailable, true, 'split by env ⇒ claim is true again');
    await setPlan(store, 'premium');
    assert.equal((await getMeterState(store, USER)).engineUpgradeAvailable, false, 'never shown to a paid user');
  });
});

test('flipping the web default does not quietly downgrade a premium-bound clinic', async () => {
  await withEnv({ VOICE_ENGINE_PAID: undefined, OPENAI_REALTIME_MODEL: undefined, VOICE_ENGINE_TENANT_PREMIUM: undefined, VOICE_ENGINE_FREE: undefined, VOICE_ENGINE_TENANT_STANDARD: undefined }, () => {
    assert.equal(resolveTenantEngine({ tier: 'paid', grade: 'premium' }).model, 'gpt-realtime');
    assert.equal(resolveTenantEngine({ tier: 'paid', grade: 'standard' }).model, 'gpt-realtime-2.1-mini');
  });
  await withEnv({ VOICE_ENGINE_PAID: 'gpt-realtime-x', VOICE_ENGINE_TENANT_PREMIUM: undefined }, () => {
    assert.equal(resolveTenantEngine({ tier: 'paid', grade: 'premium' }).model, 'gpt-realtime-x', 'an explicit paid lever still wins');
  });
});
