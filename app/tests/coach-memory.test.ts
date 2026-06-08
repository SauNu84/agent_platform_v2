import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { createCoachFromMarkdown } from '@/services/coaches';
import { runCoachSession } from '@/voice/coach-session';
import { recordConsentChange, getCoachConsent } from '@/coach/consent';
import { embed, cosine, deriveMemories, rankMemories, expiresAtFor } from '@/coach/memory';
import type { CoachMemoryRecord } from '@/db/store';
import type { Transcript } from '@/voice/realtime-interface';

const SCENARIO_MD = `---
id: pitch-practice
name: Pitch Practice
persona: You are a tough Series A investor running a practice pitch.
visibility: public
---
`;
const COACH_MD = `---
id: pitch-coach
name: Pitch Coach
scenario_ref: pitch-practice
retention: persistent
schedule:
  cadence: weekly
---
`;

const USER = '00000000-0000-4000-8000-0000000000aa';

async function setup() {
  const store = new MemoryStore();
  await createScenarioFromMarkdown(store, SCENARIO_MD);
  const { coach } = await createCoachFromMarkdown(store, COACH_MD);
  const scenario = (await store.getScenarioById(coach.scenarioId!))!;
  return { store, coach, scenario };
}

function transcriptWith(text: string): Transcript {
  return {
    sessionId: 'test-session',
    turns: [{ role: 'user', text, at: 1 }, { role: 'agent', text: 'Noted.', at: 2 }],
    toolCalls: [],
    startedAt: 1,
    endedAt: 1000,
  };
}

// ── unit: embedding / similarity ──
test('embed produces a unit vector; similar text scores higher than dissimilar', () => {
  const a = embed('series a pitch funding investors');
  const b = embed('series a pitch funding round');
  const c = embed('favorite pasta recipe cooking');
  assert.ok(cosine(a, a) > 0.999); // normalized
  assert.ok(cosine(a, b) > cosine(a, c));
});

// ── unit: derivation ──
test('deriveMemories extracts a summary + first-person facts/goals/preferences', () => {
  const t = transcriptWith('I am preparing for a Series A pitch. I prefer concise feedback.');
  const mems = deriveMemories(t, 'Pitch Coach');
  assert.ok(mems.some((m) => m.kind === 'summary'));
  assert.ok(mems.some((m) => m.kind === 'goal' && /Series A/.test(m.content)));
  assert.ok(mems.some((m) => m.kind === 'preference' && /concise/.test(m.content)));
});

// ── unit: ranking ──
test('rankMemories with a query surfaces the semantically relevant memory first', () => {
  const now = Date.parse('2026-06-08T00:00:00Z');
  const mk = (id: string, content: string): CoachMemoryRecord => ({
    id, coachId: 'c', userId: USER, kind: 'fact', content, embedding: embed(content),
    sourceSessionId: null, salience: 1, createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1e10).toISOString(),
  });
  const cands = [mk('1', 'enjoys hiking on weekends'), mk('2', 'preparing for a Series A fundraise pitch')];
  const ranked = rankMemories(cands, { query: 'series a pitch advice', nowMs: now, k: 2 });
  assert.equal(ranked[0].id, '2');
});

// ── headline acceptance: memory demonstrably affects the next session ──
test('a coach remembers prior sessions: retrieval affects the next session', async () => {
  const { store, coach, scenario } = await setup();
  await recordConsentChange({ store, userId: USER, coachId: coach.id, consentType: 'persistent_memory', action: 'granted' });

  // Session 1: learner states a durable fact (client transcript path).
  const r1 = await runCoachSession({
    store, coach, scenario, vendor: 'mock', userId: USER,
    transcript: transcriptWith('I am preparing for a Series A pitch. I prefer concise feedback.'),
  });
  assert.ok(r1.wroteMemories >= 1, 'session 1 persisted memory');
  assert.equal(r1.injectedMemories.length, 0, 'session 1 had no prior memory to inject');

  // Session 2: a fresh (server-driven mock) session retrieves + injects session 1's memory.
  const r2 = await runCoachSession({ store, coach, scenario, vendor: 'mock', userId: USER });
  assert.ok(r2.injectedMemories.length >= 1, 'session 2 retrieved prior memory');
  assert.match(r2.injectedInstructions, /What you remember about this learner/);
  assert.match(r2.injectedInstructions, /Series A/, 'the remembered fact is injected into the next session');
});

// ── consent gate (ADR-004): no consent ⇒ no memory written ──
test('without persistent-memory consent, nothing is remembered', async () => {
  const { store, coach, scenario } = await setup();
  const r = await runCoachSession({
    store, coach, scenario, vendor: 'mock', userId: USER,
    transcript: transcriptWith('I am preparing for a Series A pitch.'),
  });
  assert.equal(r.wroteMemories, 0);
  assert.match(r.memorySkippedReason ?? '', /consent/);
  assert.equal((await store.listCoachMemory(coach.id, USER)).length, 0);
});

// ── DSAR: wipe erases all memory for (coach,user) ──
test('wipe memory erases everything for the user (right to erasure)', async () => {
  const { store, coach, scenario } = await setup();
  await recordConsentChange({ store, userId: USER, coachId: coach.id, consentType: 'persistent_memory', action: 'granted' });
  await runCoachSession({ store, coach, scenario, vendor: 'mock', userId: USER, transcript: transcriptWith('I am a product manager. My goal is to raise a seed round.') });
  assert.ok((await store.listCoachMemory(coach.id, USER)).length > 0);
  const wiped = await store.wipeCoachMemory(coach.id, USER);
  assert.ok(wiped > 0);
  assert.equal((await store.listCoachMemory(coach.id, USER)).length, 0);
});

// ── consent state is reconstructed from the append-only log ──
test('consent is append-only and reconstructable; revoke flips state', async () => {
  const { store, coach } = await setup();
  await recordConsentChange({ store, userId: USER, coachId: coach.id, consentType: 'persistent_memory', action: 'granted' });
  let state = await getCoachConsent(store, USER, coach.id);
  assert.equal(state.persistentMemory, true);
  await recordConsentChange({ store, userId: USER, coachId: coach.id, consentType: 'persistent_memory', action: 'revoked' });
  state = await getCoachConsent(store, USER, coach.id);
  assert.equal(state.persistentMemory, false);
  const log = await store.listConsent(USER, `coach:${coach.id}`);
  assert.equal(log.length, 2, 'revocation is a new row, not an update');
});

test('expiresAtFor: summaries 365d, durable kinds 24mo', () => {
  const from = Date.parse('2026-06-08T00:00:00Z');
  const summary = Date.parse(expiresAtFor('summary', from));
  const fact = Date.parse(expiresAtFor('fact', from));
  assert.ok(Math.abs(summary - from - 365 * 86400000) < 1000);
  assert.ok(Math.abs(fact - from - 730 * 86400000) < 1000);
});
