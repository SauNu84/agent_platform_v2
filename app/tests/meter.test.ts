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

function minutesTranscript(minutes: number): Transcript {
  return {
    sessionId: 's', turns: [{ role: 'user', text: 'hi', at: 0 }], toolCalls: [],
    startedAt: 0, endedAt: minutes * 60_000,
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
  await store.upsertEntitlement({ userId: 'u1', plan: 'paid', freeMinutes: 30, paidMinutes: 120 });
  const state = await getMeterState(store, 'u1');
  assert.equal(state.capMinutes, 150);
  assert.equal(state.plan, 'paid');
  // within cap → no throw
  await assert.doesNotReject(() => assertWithinCap(store, 'u1'));
});
