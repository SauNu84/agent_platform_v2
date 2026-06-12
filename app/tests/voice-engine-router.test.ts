/**
 * SAU-256 — tiered voice model router + per-tier metering.
 *
 * Verifies the build-side acceptance criteria of the HYBRID Phase 1:
 *  - free tier routes to the cheaper engine, paid tier to the "Super" engine;
 *  - engine ids are config-driven (env), not hard-coded;
 *  - voice_usage records the tier + engine per session;
 *  - the voice KB inject is bounded well under the 150K text budget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { runVoiceSession } from '@/voice/session-service';
import {
  resolveVoiceTier, resolveVoiceEngine, resolveTierForUser, resolveSessionEngine,
  voiceKbCharBudget, tierMinuteBudget, DEFAULT_VOICE_KB_CHAR_BUDGET,
} from '@/voice/engine-router';
import { KB_CONTEXT_CHAR_BUDGET } from '@/domain/scenario';

const MD = `---
id: router-demo
name: Router Demo
persona: be a friendly coach
visibility: public
---
`;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}

test('resolveVoiceTier maps billing plan_tier → voice tier', () => {
  assert.equal(resolveVoiceTier('free'), 'free');
  assert.equal(resolveVoiceTier(undefined), 'free');
  assert.equal(resolveVoiceTier(null), 'free');
  assert.equal(resolveVoiceTier('standard'), 'paid');
  assert.equal(resolveVoiceTier('premium'), 'paid');
});

test('engine ids are config-driven, defaulting to mini (free) / gpt-realtime (paid)', () => {
  withEnv({ VOICE_ENGINE_FREE: undefined, VOICE_ENGINE_PAID: undefined, OPENAI_REALTIME_MODEL: undefined }, () => {
    assert.equal(resolveVoiceEngine('free').model, 'gpt-realtime-mini');
    assert.equal(resolveVoiceEngine('paid').model, 'gpt-realtime');
  });
  // Overridable via env — proves the seam (e.g. point free at Gemini Flash later).
  withEnv({ VOICE_ENGINE_FREE: 'gemini-2.5-flash-live', VOICE_ENGINE_PAID: 'gpt-realtime-pro' }, () => {
    assert.equal(resolveVoiceEngine('free').model, 'gemini-2.5-flash-live');
    assert.equal(resolveVoiceEngine('paid').model, 'gpt-realtime-pro');
  });
});

test('voice KB budget is bounded far under the 150K text budget', () => {
  assert.ok(DEFAULT_VOICE_KB_CHAR_BUDGET < KB_CONTEXT_CHAR_BUDGET);
  withEnv({ VOICE_KB_CHAR_BUDGET: undefined }, () => assert.equal(voiceKbCharBudget(), DEFAULT_VOICE_KB_CHAR_BUDGET));
  withEnv({ VOICE_KB_CHAR_BUDGET: '8000' }, () => assert.equal(voiceKbCharBudget(), 8000));
});

test('tierMinuteBudget: free is capped, paid uncapped by default (never "unlimited" exposed)', () => {
  withEnv({ VOICE_FREE_MINUTE_BUDGET: undefined, CREDIT_FREE_MINUTES: undefined, VOICE_PAID_MINUTE_BUDGET: undefined }, () => {
    assert.equal(tierMinuteBudget('free'), 30);
    assert.equal(tierMinuteBudget('paid'), null); // metered, no hard cap — enforcement is product policy
  });
});

test('resolveTierForUser reads the billing entitlement (anonymous ⇒ free)', async () => {
  const store = new MemoryStore();
  assert.equal(await resolveTierForUser(store, null), 'free');
  await store.upsertEntitlement({ userId: 'u-free', plan: 'free', freeMinutes: 30, paidMinutes: 0, planTier: 'free' });
  await store.upsertEntitlement({ userId: 'u-prem', plan: 'paid', freeMinutes: 30, paidMinutes: 500, planTier: 'premium' });
  assert.equal(await resolveTierForUser(store, 'u-free'), 'free');
  assert.equal(await resolveTierForUser(store, 'u-prem'), 'paid');
});

test('free-tier voice session is metered with the cheaper engine', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  await withEnvAsync({ VOICE_ENGINE_FREE: undefined }, async () => {
    const result = await runVoiceSession({ store, scenario, vendor: 'mock', tier: 'free', userId: 'u1' });
    const usage = await store.getVoiceUsage(result.sessionId);
    assert.equal(usage!.tier, 'free');
    assert.equal(usage!.engine, 'gpt-realtime-mini');
  });
});

test('paid-tier voice session is metered with the Super engine', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  await withEnvAsync({ VOICE_ENGINE_PAID: undefined, OPENAI_REALTIME_MODEL: undefined }, async () => {
    const result = await runVoiceSession({ store, scenario, vendor: 'mock', tier: 'paid', userId: 'u2' });
    const usage = await store.getVoiceUsage(result.sessionId);
    assert.equal(usage!.tier, 'paid');
    assert.equal(usage!.engine, 'gpt-realtime');
  });
});

test('voiceUsageByTier aggregates blended usage by tier + engine', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  await runVoiceSession({ store, scenario, vendor: 'mock', tier: 'free', userId: 'a' });
  await runVoiceSession({ store, scenario, vendor: 'mock', tier: 'free', userId: 'b' });
  await runVoiceSession({ store, scenario, vendor: 'mock', tier: 'paid', userId: 'c' });
  const byTier = await store.voiceUsageByTier();
  const free = byTier.find((r) => r.tier === 'free');
  const paid = byTier.find((r) => r.tier === 'paid');
  assert.equal(free?.sessions, 2);
  assert.equal(paid?.sessions, 1);
  assert.ok((free?.totalTokens ?? 0) > 0);
});

// ── SAU-258: multi-vendor picker — vendor choice + tiered OpenAI ─────────────

test('resolveSessionEngine honors the scenario author vendor choice for a paid viewer', () => {
  withEnv({ VOICE_ENGINE_FREE: undefined, VOICE_ENGINE_PAID: undefined, OPENAI_REALTIME_MODEL: undefined, VOICE_ENGINE_GEMINI: undefined }, () => {
    const gem = resolveSessionEngine({ modelId: 'google-gemini', tier: 'paid' });
    assert.equal(gem.vendor, 'gemini');
    assert.equal(gem.model, 'gemini-2.5-flash-preview-native-audio-dialog');
    assert.equal(gem.engineClass, 'cost');
    assert.equal(gem.downgraded, false);

    // OpenAI Realtime is a single tiered vendor entry — paid → premium engine.
    const oai = resolveSessionEngine({ modelId: 'openai-realtime', tier: 'paid' });
    assert.equal(oai.vendor, 'openai');
    assert.equal(oai.model, 'gpt-realtime');
    assert.equal(oai.engineClass, 'tiered');
    assert.equal(oai.downgraded, false);
  });
});

test('tiered OpenAI: a free viewer runs the standard engine (downgraded), never premium', () => {
  withEnv({ VOICE_ENGINE_FREE: undefined, VOICE_ENGINE_PAID: undefined, OPENAI_REALTIME_MODEL: undefined }, () => {
    const free = resolveSessionEngine({ modelId: 'openai-realtime', tier: 'free' });
    assert.equal(free.downgraded, true);          // free runs standard, not premium
    assert.equal(free.modelId, 'openai-realtime'); // single vendor entry, no separate mini row
    assert.equal(free.model, 'gpt-realtime-mini');
    assert.equal(free.vendor, 'openai');
    // Gemini is one cost engine on every plan — no tiering.
    const gem = resolveSessionEngine({ modelId: 'google-gemini', tier: 'free' });
    assert.equal(gem.downgraded, false);
    assert.equal(gem.vendor, 'gemini');
  });
});

test('unknown / not-yet-runnable engine falls back to the default (then tiered by plan)', () => {
  withEnv({ VOICE_ENGINE_FREE: undefined, VOICE_ENGINE_PAID: undefined, OPENAI_REALTIME_MODEL: undefined }, () => {
    // 'anthropic-claude' is available:false → default openai-realtime → free standard engine.
    const soon = resolveSessionEngine({ modelId: 'anthropic-claude', tier: 'free' });
    assert.equal(soon.model, 'gpt-realtime-mini');
    // bogus id → default → paid gets the premium engine.
    const bogus = resolveSessionEngine({ modelId: 'nope', tier: 'paid' });
    assert.equal(bogus.model, 'gpt-realtime');
  });
});

test('Gemini engine id is config-driven (VOICE_ENGINE_GEMINI overridable)', () => {
  withEnv({ VOICE_ENGINE_GEMINI: 'gemini-live-x' }, () => {
    assert.equal(resolveSessionEngine({ modelId: 'google-gemini', tier: 'paid' }).model, 'gemini-live-x');
  });
});

test('per-engine metering: a Gemini-selected session records the gemini engine (mock fail-soft, no key)', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  await withEnvAsync({ GEMINI_API_KEY: undefined, VOICE_ENGINE_GEMINI: undefined }, async () => {
    // vendor 'gemini' with no key falls back to the mock transport (no crash),
    // but the resolved ENGINE id is still recorded for cost observability.
    const result = await runVoiceSession({ store, scenario, vendor: 'gemini', tier: 'paid', modelId: 'google-gemini', userId: 'g1' });
    const usage = await store.getVoiceUsage(result.sessionId);
    assert.equal(usage!.engine, 'gemini-2.5-flash-preview-native-audio-dialog');
    assert.equal(usage!.tier, 'paid');
    const byTier = await store.voiceUsageByTier();
    assert.ok(byTier.some((r) => r.engine === 'gemini-2.5-flash-preview-native-audio-dialog'));
  });
});

test('free viewer of the tiered OpenAI engine is metered on the standard cost engine', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  await withEnvAsync({ VOICE_ENGINE_FREE: undefined }, async () => {
    const result = await runVoiceSession({ store, scenario, vendor: 'mock', tier: 'free', modelId: 'openai-realtime', userId: 'f1' });
    const usage = await store.getVoiceUsage(result.sessionId);
    assert.equal(usage!.engine, 'gpt-realtime-mini'); // standard, never billed at premium
  });
});

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
}
