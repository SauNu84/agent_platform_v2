import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { runVoiceSession, persistClientSession } from '@/voice/session-service';
import type { Transcript } from '@/voice/realtime-interface';

const MD = `---
id: voice-demo
name: Voice Demo
persona: be a friendly coach
tools: [slides]
visibility: public
---
`;

test('Join runs a live (mock) voice session, saves a transcript, and meters usage', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);

  const result = await runVoiceSession({ store, scenario, vendor: 'mock' });

  // transcript saved
  assert.equal(result.transcript.turns.length, 6, '3 user + 3 agent turns');
  assert.equal(result.transcript.turns[0].role, 'user');
  assert.equal(result.transcript.toolCalls.length, 1, 'first turn exercises the slides tool');
  assert.equal(result.transcript.toolCalls[0].name, 'slides');

  // session row completed + transcript persisted
  const session = await store.getSession(result.sessionId);
  assert.equal(session?.status, 'completed');
  assert.equal(session?.transcript?.turns.length, 6);

  // semantic events persisted (transcripts + tool.call/result), no raw audio frames
  const events = await store.listSessionEvents(result.sessionId);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('user.transcript'));
  assert.ok(types.includes('agent.transcript'));
  assert.ok(types.includes('tool.call'));
  assert.ok(!types.includes('audio.output'), 'PCM frames are never persisted as events');

  // voice usage metered (Slice-1 requirement: record usage now)
  const usage = await store.getVoiceUsage(result.sessionId);
  assert.ok(usage, 'voice_usage row recorded');
  assert.equal(usage!.totalTokens, 3 * 960, 'summed measured tokens across 3 turns');
  assert.ok(usage!.outputAudioTokens > 0);
  assert.equal(usage!.vendor, 'mock');
  assert.equal(usage!.model, 'mock-realtime');
  assert.ok(usage!.voiceMinutes >= 0);
});

test('client-driven session persists + meters identically', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);

  const transcript: Transcript = {
    sessionId: 'client-1',
    turns: [
      { role: 'user', text: 'hello', at: 1000 },
      { role: 'agent', text: 'hi there', at: 1200 },
    ],
    toolCalls: [],
    startedAt: 1000,
    endedAt: 1000 + 90_000, // 90s
    usage: {
      perTurn: [],
      totals: {
        inputTextTokens: 10, inputAudioTokens: 100, cachedTextTokens: 0,
        cachedAudioTokens: 0, outputTextTokens: 5, outputAudioTokens: 50, totalTokens: 165,
      },
    },
    model: 'gpt-realtime',
  };

  const result = await persistClientSession({ store, scenario, vendor: 'openai', transcript });
  const session = await store.getSession(result.sessionId);
  assert.equal(session?.transcript?.turns.length, 2);
  const usage = await store.getVoiceUsage(result.sessionId);
  assert.equal(usage!.totalTokens, 165);
  assert.equal(usage!.voiceMinutes, 1.5, '90s = 1.5 voice minutes');
  assert.equal(usage!.model, 'gpt-realtime');
});
