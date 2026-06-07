/**
 * Harness self-test (no network). Asserts the PURE metric math against synthetic
 * event windows with known timings, then runs the full mock bench end-to-end and
 * checks the aggregate numbers land in the expected band. Run: `tsx harness.test.ts`.
 *
 * This is what lets us trust the numbers a live run will produce: the measurement
 * pipeline is verified independently of any vendor.
 */
import assert from 'node:assert';
import {
  computeTurnMetric, percentile, costPerConversationMinute, summarize,
  usageCost, usageCostUncached, projectCostPerMin, costBand, computeMeasuredCost,
  REALTIME_RATES,
} from './bench.ts';
import type { SessionEvent, TurnUsage, SessionUsage } from './realtime-interface.ts';
import type { FixtureTurn } from './fixtures/fixture.ts';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('percentile()');
check('nearest-rank p50/p95 on a known set', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 100);
  assert.equal(percentile(xs, 100), 100);
});
check('ignores nulls, returns null on empty', () => {
  assert.equal(percentile([null, undefined, 42], 50), 42);
  assert.equal(percentile([null, null], 95), null);
});

console.log('computeTurnMetric() — TTFA');
check('TTFA = first audio.output − userUtteranceEnd', () => {
  const end = 1000;
  const w: SessionEvent[] = [
    { type: 'user.transcript', text: 'x', final: true, at: 1000 },
    { type: 'audio.output', pcm: new Int16Array(0), at: 1180 },
    { type: 'audio.output', pcm: new Int16Array(0), at: 1260 },
  ];
  const turn: FixtureTurn = { index: 0, kind: 'normal', userMs: 1200 };
  const m = computeTurnMetric(turn, end, w);
  assert.equal(m.ttfaMs, 180);
  assert.equal(m.bargeInStopMs, null);
  assert.equal(m.toolDeadAirMs, null);
});

console.log('computeTurnMetric() — barge-in');
check('bargeInStop = interrupted − speech.started', () => {
  const end = 2000;
  const w: SessionEvent[] = [
    { type: 'audio.output', pcm: new Int16Array(0), at: 2150 },
    { type: 'user.speech.started', at: 2600 },
    { type: 'agent.interrupted', at: 2740 },
  ];
  const turn: FixtureTurn = { index: 7, kind: 'bargein', userMs: 1000, bargeInAfterMs: 400 };
  const m = computeTurnMetric(turn, end, w);
  assert.equal(m.bargeInStopMs, 140);
  assert.equal(m.ttfaMs, 150);
});

console.log('computeTurnMetric() — mid-turn tool dead-air');
check('dead-air = largest gap with no audio between tool.call and tool.result', () => {
  const end = 3000;
  const w: SessionEvent[] = [
    { type: 'audio.output', pcm: new Int16Array(0), at: 3150 },
    { type: 'tool.call', id: 'c1', name: 'lookupPrice', args: {}, at: 3300 },
    { type: 'audio.output', pcm: new Int16Array(0), at: 3380 }, // keeps talking
    { type: 'audio.output', pcm: new Int16Array(0), at: 3460 },
    { type: 'tool.result', id: 'c1', result: {}, at: 3560 },
  ];
  const turn: FixtureTurn = { index: 5, kind: 'tool', userMs: 1500 };
  const m = computeTurnMetric(turn, end, w);
  // gaps: 3300→3380=80, 3380→3460=80, 3460→3560=100 ⇒ max 100
  assert.equal(m.toolDeadAirMs, 100);
});
check('dead-air detects a stall (no audio while tool runs)', () => {
  const end = 4000;
  const w: SessionEvent[] = [
    { type: 'tool.call', id: 'c1', name: 'lookupPrice', args: {}, at: 4300 },
    { type: 'tool.result', id: 'c1', result: {}, at: 6100 }, // 1800ms of silence
  ];
  const turn: FixtureTurn = { index: 5, kind: 'tool', userMs: 1500 };
  const m = computeTurnMetric(turn, end, w);
  assert.equal(m.toolDeadAirMs, 1800);
  assert.ok(m.toolDeadAirMs! > 1500, 'should exceed the 1.5s pass bar');
});

console.log('costPerConversationMinute()');
check('applies accumulating-context multiplier + infra', () => {
  const c = costPerConversationMinute({ label: 'x', audioInPerMin: 0.06, audioOutPerMin: 0.24, infraPerMin: 0.01, contextMultiplier: 1.6 });
  // (0.06 + 0.24) * 1.6 + 0.01 = 0.49
  assert.ok(Math.abs(c - 0.49) < 1e-9, `got ${c}`);
});

console.log('usageCost() — measured token cost (SAU-197)');
check('bills cached input at the cached rate, rest at full rate', () => {
  const r = REALTIME_RATES['gpt-realtime'];
  // 1M audio in (half cached), 1M audio out, no text.
  const u: TurnUsage = {
    inputTextTokens: 0, inputAudioTokens: 1_000_000,
    cachedTextTokens: 0, cachedAudioTokens: 500_000,
    outputTextTokens: 0, outputAudioTokens: 1_000_000, totalTokens: 2_000_000,
  };
  // in: 500k*$32/1M + 500k*$0.40/1M = 16 + 0.20 = 16.20 ; out: 1M*$64/1M = 64 ⇒ 80.20
  assert.ok(Math.abs(usageCost(u, r) - 80.20) < 1e-9, `got ${usageCost(u, r)}`);
  // uncached counterfactual: 1M*$32 + 1M*$64 = 96
  assert.ok(Math.abs(usageCostUncached(u, r) - 96.0) < 1e-9, `got ${usageCostUncached(u, r)}`);
});

console.log('projectCostPerMin() — 6-min projection w/ context accumulation');
check('flat per-turn cost ⇒ flat $/min; rising per-turn cost ⇒ higher 6-min $/min', () => {
  // 50 turns over 4 min, flat $0.01/turn ⇒ 12.5 turns/min ⇒ 6min=75 turns ⇒ $0.75/6 = $0.125/min
  const flat = Array(50).fill(0.01);
  assert.ok(Math.abs(projectCostPerMin(flat, 4, 6) - 0.125) < 1e-6, `flat got ${projectCostPerMin(flat, 4, 6)}`);
  // rising cost: 6-min projection must exceed the as-run per-min (accumulation slope > 0)
  const rising = Array.from({ length: 50 }, (_, i) => 0.01 + i * 0.0002);
  const asRunPerMin = rising.reduce((a, b) => a + b, 0) / 4;
  assert.ok(projectCostPerMin(rising, 4, 6) > asRunPerMin, 'rising trend should project higher per-min at 6 min');
});

console.log('costBand() — CFO envelope (COST-ENVELOPE.md §2)');
check('🟢 ≤0.09, 🟡 0.09–0.15, 🔴 >0.15', () => {
  assert.equal(costBand(0.08), '🟢');
  assert.equal(costBand(0.12), '🟡');
  assert.equal(costBand(0.20), '🔴');
});

console.log('computeMeasuredCost() — end-to-end token→cost block');
check('summarize() attaches measuredCost from transcript.usage', () => {
  const perTurn: TurnUsage[] = Array.from({ length: 10 }, (_, i) => ({
    inputTextTokens: 100, inputAudioTokens: 1000 + i * 500, // input grows (context accumulation)
    cachedTextTokens: 0, cachedAudioTokens: i * 450,        // most growth is cached
    outputTextTokens: 50, outputAudioTokens: 800,
    totalTokens: 0,
  }));
  const totals: TurnUsage = perTurn.reduce((acc, t) => ({
    inputTextTokens: acc.inputTextTokens + t.inputTextTokens,
    inputAudioTokens: acc.inputAudioTokens + t.inputAudioTokens,
    cachedTextTokens: acc.cachedTextTokens + t.cachedTextTokens,
    cachedAudioTokens: acc.cachedAudioTokens + t.cachedAudioTokens,
    outputTextTokens: acc.outputTextTokens + t.outputTextTokens,
    outputAudioTokens: acc.outputAudioTokens + t.outputAudioTokens,
    totalTokens: 0,
  }), { inputTextTokens: 0, inputAudioTokens: 0, cachedTextTokens: 0, cachedAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0, totalTokens: 0 });
  const usage: SessionUsage = { perTurn, totals };
  const mc = computeMeasuredCost(usage, 'gpt-realtime', 4);
  assert.ok(mc.sessionCostUsd > 0, 'session cost positive');
  assert.ok(mc.cachingReductionPct > 0, 'caching reduces cost');
  assert.ok(mc.cachedInputPct > 0 && mc.cachedInputPct < 100, 'cache pct in range');
  assert.equal(mc.model, 'gpt-realtime');
  const t = { sessionId: 's', turns: [{ role: 'user' as const, text: 'x', at: 1 }], toolCalls: [], startedAt: 0, endedAt: 240_000, usage, model: 'gpt-realtime' };
  const r = summarize('openai', [{ index: 0, kind: 'normal' as const, ttfaMs: 900, bargeInStopMs: null, toolDeadAirMs: null }], t);
  assert.ok(r.measuredCost, 'measuredCost attached');
  assert.equal(r.costPerConvMin, r.measuredCost!.projected6MinCostPerConvMin, 'headline cost = 6-min projection');
});

console.log('summarize() pass-bar gating');
check('flags fail when p95 exceeds bars', () => {
  const metrics = [
    { index: 0, kind: 'normal' as const, ttfaMs: 900, bargeInStopMs: null, toolDeadAirMs: null },
    { index: 1, kind: 'bargein' as const, ttfaMs: 950, bargeInStopMs: 500, toolDeadAirMs: null },
    { index: 2, kind: 'tool' as const, ttfaMs: 920, bargeInStopMs: null, toolDeadAirMs: 2000 },
  ];
  const t = { sessionId: 's', turns: [{ role: 'user' as const, text: 'x', at: 1 }], toolCalls: [], startedAt: 0, endedAt: 1 };
  const r = summarize('openai', metrics, t);
  assert.equal(r.passes.ttfa, false);
  assert.equal(r.passes.bargeIn, false);
  assert.equal(r.passes.tool, false);
  assert.equal(r.transcriptPersisted, true);
});

console.log(`\nAll ${passed} metric assertions passed.`);
