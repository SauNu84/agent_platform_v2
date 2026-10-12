import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { persistClientSession } from '@/voice/session-service';
import { getMeterState, assertWithinCap, CapExceededError, DEFAULT_FREE_MINUTES } from '@/services/meter';
import type { Transcript } from '@/voice/realtime-interface';

const MD = `---
id: meter-demo
name: Meter Demo
persona: coach
visibility: public
---
`;

// Anchor sessions to "now" so they fall inside the current calendar month — the
// SAU-257 meter sums month-to-date usage (the free allotment resets monthly).
// Duration (= metered minutes) is endedAt − startedAt, independent of the anchor.
function minutesTranscript(minutes: number, startedAt: number = Date.now()): Transcript {
  return {
    sessionId: 's', turns: [{ role: 'user', text: 'hi', at: 0 }], toolCalls: [],
    startedAt, endedAt: startedAt + minutes * 60_000,
  };
}

test('meter sums recorded voice minutes and computes remaining against the cap', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  await persistClientSession({ store, scenario, vendor: 'mock', userId: 'u1', transcript: minutesTranscript(10) });
  await persistClientSession({ store, scenario, vendor: 'mock', userId: 'u1', transcript: minutesTranscript(5) });
  // a different user's usage must not count
  await persistClientSession({ store, scenario, vendor: 'mock', userId: 'u2', transcript: minutesTranscript(99) });

  const state = await getMeterState(store, 'u1');
  assert.equal(state.usedMinutes, 15);
  assert.equal(state.capMinutes, DEFAULT_FREE_MINUTES);
  assert.equal(state.remainingMinutes, DEFAULT_FREE_MINUTES - 15);
  assert.equal(state.overCap, false);
});

test('cap is enforced once usage meets the entitlement', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  // entitle u1 to a tiny 2-minute free plan, then burn it
  await store.upsertEntitlement({ userId: 'u1', plan: 'free', freeMinutes: 2, paidMinutes: 0 });
  await persistClientSession({ store, scenario, vendor: 'mock', userId: 'u1', transcript: minutesTranscript(2) });

  await assert.rejects(() => assertWithinCap(store, 'u1'), CapExceededError);
  const state = await getMeterState(store, 'u1');
  assert.equal(state.overCap, true);
  assert.equal(state.remainingMinutes, 0);
});

test('paid minutes raise the cap', async () => {
  const store = new MemoryStore();
  await store.upsertEntitlement({ userId: 'u1', plan: 'paid', freeMinutes: 30, paidMinutes: 120, planTier: 'standard' });
  const state = await getMeterState(store, 'u1');
  assert.equal(state.capMinutes, 150);
  assert.equal(state.plan, 'paid');
  // within cap → no throw
  await assert.doesNotReject(() => assertWithinCap(store, 'u1'));
});

// ── SAU-257: monthly reset + per-tier policy ──────────────────────────────────

test('usage from a prior month does not count against this month (monthly reset)', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  // A 20-minute session that started ~45 days ago (previous calendar month).
  const lastMonth = Date.now() - 45 * 24 * 60 * 60 * 1000;
  await persistClientSession({ store, scenario, vendor: 'mock', userId: 'u1', transcript: minutesTranscript(20, lastMonth) });
  // A 5-minute session this month.
  await persistClientSession({ store, scenario, vendor: 'mock', userId: 'u1', transcript: minutesTranscript(5) });

  const state = await getMeterState(store, 'u1');
  assert.equal(state.usedMinutes, 5, 'only this month\'s usage counts');
  assert.equal(state.remainingMinutes, DEFAULT_FREE_MINUTES - 5);
  assert.equal(state.overCap, false);
});

test('free tier exposes the config-driven policy (engine, session cap, fallback, reset)', async () => {
  const store = new MemoryStore();
  const state = await getMeterState(store, 'anon-free');
  assert.equal(state.tier, 'free');
  assert.equal(state.policy.voiceEngine, 'gpt-realtime-2.1-mini');
  assert.equal(state.policy.voiceMinutesPerMonth, 30);
  assert.equal(state.sessionMaxMinutes, 10);
  assert.equal(state.onExhausted, 'text_chat_fallback');
  assert.ok(!Number.isNaN(Date.parse(state.resetsAt)), 'resetsAt is an ISO date');
});

test('session allowance is bounded by the per-session cap, not just the monthly remainder', async () => {
  const store = new MemoryStore();
  // Fresh free user: 30 min/month remaining, but a 10-min per-session soft cap.
  const state = await getMeterState(store, 'u-fresh');
  assert.equal(state.remainingMinutes, 30);
  assert.equal(state.sessionAllowanceMinutes, 10, 'one session cannot draw the whole month');
});

test('paid tier resolves the Super engine and a 25-min session cap', async () => {
  const store = new MemoryStore();
  await store.upsertEntitlement({ userId: 'u-pro', plan: 'paid', freeMinutes: 30, paidMinutes: 1000, planTier: 'premium' });
  const state = await getMeterState(store, 'u-pro');
  assert.equal(state.tier, 'paid');
  assert.equal(state.policy.voiceEngine, 'gpt-realtime-2.1-mini'); // SAU-534: both tiers on mini
  assert.equal(state.sessionMaxMinutes, 25);
});
