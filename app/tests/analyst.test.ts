import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { analyzeSession, AnalystError, HeuristicScorer } from '@/services/analyst';
import type { Transcript } from '@/voice/realtime-interface';
import { persistClientSession } from '@/voice/session-service';

const MD = `---
id: objection-handling
name: Objection Handling
persona: be a tough buyer
rubric:
  - { topic: discovery questions, weight: 40 }
  - { topic: pricing objection, weight: 60 }
visibility: public
---
`;

function transcriptWith(userTexts: string[]): Transcript {
  const turns = userTexts.flatMap((t, i) => [
    { role: 'user' as const, text: t, at: 1000 + i * 100 },
    { role: 'agent' as const, text: `ack ${i}`, at: 1050 + i * 100 },
  ]);
  return { sessionId: 'x', turns, toolCalls: [], startedAt: 1000, endedAt: 1000 + 120_000 };
}

async function seedCompletedSession(store: MemoryStore, userTexts: string[]) {
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  const result = await persistClientSession({
    store, scenario, vendor: 'mock', userId: 'u1', transcript: transcriptWith(userTexts),
  });
  return result.sessionId;
}

test('Analyst scores a completed session against the rubric and persists it', async () => {
  const store = new MemoryStore();
  // learner engages BOTH rubric topics by keyword
  const sessionId = await seedCompletedSession(store, [
    'I started with discovery questions about their needs',
    'then I handled the pricing objection by reframing value',
  ]);

  const analysis = await analyzeSession(store, sessionId);

  assert.equal(analysis.scorer, 'heuristic');
  assert.equal(analysis.evaluation.reportCard.length, 2);
  // both topics covered → high scores → strengths, no weaknesses
  assert.ok(analysis.evaluation.finalScore >= 70, `expected strong score, got ${analysis.evaluation.finalScore}`);
  assert.ok(analysis.evaluation.strengths.length >= 1);

  // persisted + idempotent (re-running upserts, not duplicates)
  const stored = await store.getAnalysis(sessionId);
  assert.equal(stored?.evaluation.finalScore, analysis.evaluation.finalScore);
  const again = await analyzeSession(store, sessionId);
  assert.equal(again.evaluation.finalScore, analysis.evaluation.finalScore);
  assert.equal(stored?.createdAt, again.createdAt, 'createdAt preserved across re-score');
});

test('weights bias the final score and weak topics become improvement areas', async () => {
  const store = new MemoryStore();
  // learner only covers the LOW-weight topic (discovery), misses pricing (weight 60)
  const sessionId = await seedCompletedSession(store, ['I asked discovery questions']);
  const analysis = await analyzeSession(store, sessionId);

  const pricing = analysis.evaluation.reportCard.find((r) => r.topic === 'pricing objection')!;
  const discovery = analysis.evaluation.reportCard.find((r) => r.topic === 'discovery questions')!;
  assert.ok(discovery.score > pricing.score, 'covered topic scores higher');
  assert.ok(analysis.evaluation.weaknesses.includes('pricing objection'));
  assert.deepEqual(analysis.improvement.areas, analysis.evaluation.weaknesses);
  assert.ok(analysis.improvement.actionItems.length >= 1);
});

test('only completed sessions can be analyzed', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  const active = await store.createSession({ scenarioId: scenario.id, userId: 'u1', vendor: 'mock' });
  await assert.rejects(() => analyzeSession(store, active.id), AnalystError);
  await assert.rejects(() => analyzeSession(store, 'no-such-session'), /not found/);
});

test('heuristic scorer is deterministic', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  const t = transcriptWith(['discovery questions and pricing objection handled']);
  const scorer = new HeuristicScorer();
  const a = await scorer.score(scenario, { turns: t.turns, toolCalls: [] });
  const b = await scorer.score(scenario, { turns: t.turns, toolCalls: [] });
  assert.deepEqual(a, b);
});
