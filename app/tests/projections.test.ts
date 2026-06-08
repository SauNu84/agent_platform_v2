import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { persistClientSession } from '@/voice/session-service';
import { analyzeSession } from '@/services/analyst';
import { listSessionHistory, historyToCsv } from '@/services/history';
import { getCreatorAnalytics, analyticsToCsv } from '@/services/analytics';
import type { Transcript } from '@/voice/realtime-interface';

const MD_A = `---
id: scn-a
name: Scenario A
persona: coach
rubric:
  - { topic: clarity, weight: 100 }
visibility: public
---
`;
const MD_B = `---
id: scn-b
name: Scenario B
persona: coach
visibility: public
---
`;

function t(min: number, text = 'clarity was strong'): Transcript {
  return { sessionId: 's', turns: [{ role: 'user', text, at: 0 }], toolCalls: [], startedAt: 0, endedAt: min * 60_000 };
}

test('History projects a user’s sessions with scenario, duration, status, analyzed flag', async () => {
  const store = new MemoryStore();
  const { scenario: a } = await createScenarioFromMarkdown(store, MD_A);
  await createScenarioFromMarkdown(store, MD_B);

  const s1 = await persistClientSession({ store, scenario: a, vendor: 'mock', userId: 'u1', transcript: t(3) });
  await persistClientSession({ store, scenario: a, vendor: 'mock', userId: 'u2', transcript: t(9) }); // other user

  let history = await listSessionHistory(store, 'u1');
  assert.equal(history.length, 1, 'only u1’s sessions');
  assert.equal(history[0].scenarioName, 'Scenario A');
  assert.equal(history[0].scenarioSlug, 'scn-a');
  assert.equal(history[0].durationMs, 180_000);
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].analyzed, false);
  assert.equal(history[0].finalScore, null);

  // after Analyze, the row reflects analyzed + score
  await analyzeSession(store, s1.sessionId);
  history = await listSessionHistory(store, 'u1');
  assert.equal(history[0].analyzed, true);
  assert.ok((history[0].finalScore ?? 0) > 0);

  // filter by scenario + CSV export
  const filtered = await listSessionHistory(store, 'u1', { scenarioSlug: 'scn-b' });
  assert.equal(filtered.length, 0);
  const csv = historyToCsv(history);
  assert.ok(csv.split('\r\n')[0].startsWith('session_id,scenario,'));
  assert.ok(csv.includes('Scenario A'));
});

test('Creator Analytics aggregates sessions/duration/voice-minutes per scenario', async () => {
  const store = new MemoryStore();
  const { scenario: a } = await createScenarioFromMarkdown(store, MD_A);
  const { scenario: b } = await createScenarioFromMarkdown(store, MD_B);

  await persistClientSession({ store, scenario: a, vendor: 'mock', userId: 'u1', transcript: t(2) });
  await persistClientSession({ store, scenario: a, vendor: 'mock', userId: 'u1', transcript: t(4) });
  await persistClientSession({ store, scenario: b, vendor: 'mock', userId: 'u1', transcript: t(6) });

  const { rows, kpis } = await getCreatorAnalytics(store);
  assert.equal(kpis.totalScenarios, 2);
  assert.equal(kpis.totalSessions, 3);
  assert.equal(kpis.avgSessionsPerScenario, 1.5);

  const rowA = rows.find((r) => r.scenarioId === a.id)!;
  assert.equal(rowA.sessions, 2);
  assert.equal(rowA.avgDurationMs, 180_000, 'avg of 2m and 4m = 3m');
  assert.equal(rowA.totalVoiceMinutes, 6, '2 + 4 metered minutes');

  const csv = analyticsToCsv(rows);
  assert.ok(csv.split('\r\n')[0].startsWith('scenario,scenario_slug,sessions,'));
});
