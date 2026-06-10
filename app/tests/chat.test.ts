import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { runChatTurn } from '@/chat/chat-session';
import {
  ChatResponder, ChatReplyInput, MockChatResponder, chatSystemPrompt, getResponder,
} from '@/chat/responder';
import { analyzeSession } from '@/services/analyst';
import { listSessionHistory } from '@/services/history';

const MD = `---
id: chat-demo
name: Chat Demo
description: Practice a tricky conversation.
persona: |
  You are Dana, a skeptical enterprise security buyer. Stay in character and push
  back on vague claims.
rubric:
  - topic: Discovery
    weight: 50
    note: Did the learner ask about security requirements?
  - topic: Objection handling
    weight: 50
    note: Did the learner address concerns with specifics?
visibility: public
---
`;

/** A scripted responder so replies are deterministic + we can assert persona use. */
class ScriptedResponder implements ChatResponder {
  readonly name = 'scripted';
  lastSystem = '';
  calls = 0;
  constructor(private replies: string[]) {}
  async reply(input: ChatReplyInput): Promise<string> {
    this.lastSystem = input.system;
    return this.replies[Math.min(this.calls++, this.replies.length - 1)];
  }
}

test('AC: a chat turn generates a persona reply and persists a completed session with the transcript', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  const responder = new ScriptedResponder(['I am Dana — convince me you understand SOC 2.']);

  const result = await runChatTurn({
    store, scenario, message: 'Hi, I sell a compliance platform.', responder, userId: 'u1', now: 1000,
  });

  // Reply returned + the persona system prompt carried the scenario instructions.
  assert.equal(result.reply, 'I am Dana — convince me you understand SOC 2.');
  assert.match(responder.lastSystem, /Dana/);
  assert.match(responder.lastSystem, /in character/i);
  assert.equal(result.vendor, 'chat:scripted');

  // Transcript = the user turn + the agent reply, in order.
  assert.equal(result.turns.length, 2);
  assert.deepEqual(result.turns.map((t) => t.role), ['user', 'agent']);

  // Session row is completed and carries the transcript (→ Sessions tab + Analyst).
  const session = await store.getSession(result.sessionId);
  assert.equal(session?.status, 'completed');
  assert.equal(session?.transcript?.turns.length, 2);
  assert.equal(session?.vendor, 'chat:scripted');

  // It shows up under the scenario's sessions list.
  const list = await store.listSessionsByScenario(scenario.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, result.sessionId);

  // Text chat is NOT metered into voice_usage — it burns no voice minutes.
  assert.equal(await store.getVoiceUsage(result.sessionId), null);
  assert.equal(await store.sumVoiceMinutesByUser('u1'), 0);
});

test('AC: continuing the conversation extends the SAME session, not a new one', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  const responder = new ScriptedResponder(['Reply one.', 'Reply two.']);

  const first = await runChatTurn({ store, scenario, message: 'turn one', responder, now: 1000 });
  const second = await runChatTurn({
    store, scenario, message: 'turn two', responder, now: 2000,
    sessionId: first.sessionId,
    history: first.turns.map((t) => ({ role: t.role, text: t.text })),
  });

  // Same session id, and only one session row exists.
  assert.equal(second.sessionId, first.sessionId);
  assert.equal((await store.listSessionsByScenario(scenario.id)).length, 1);

  // The session now holds all four turns (2 from each exchange).
  const session = await store.getSession(first.sessionId);
  assert.equal(session?.transcript?.turns.length, 4);
  assert.deepEqual(session?.transcript?.turns.map((t) => t.role), ['user', 'agent', 'user', 'agent']);
});

test('AC: a persisted chat session is analyzable and appears in History', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  const responder = new MockChatResponder();

  const result = await runChatTurn({
    store, scenario, userId: 'u1',
    message: 'I ask about your security requirements and SOC 2 objection concerns.',
    responder,
  });

  // Scorable like any other completed session.
  const analysis = await analyzeSession(store, result.sessionId);
  assert.ok(analysis.overallScore >= 0 && analysis.overallScore <= 100);

  // Appears in the user's History with the right scenario + analyzed flag.
  const rows = await listSessionHistory(store, 'u1');
  const row = rows.find((r) => r.sessionId === result.sessionId);
  assert.ok(row, 'chat session is in History');
  assert.equal(row!.scenarioSlug, 'chat-demo');
  assert.equal(row!.analyzed, true);
});

test('an empty message is rejected', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  await assert.rejects(
    () => runChatTurn({ store, scenario, message: '   ', responder: new MockChatResponder() }),
    /message is required/,
  );
});

test('getResponder falls soft to the deterministic mock when no key is configured', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(getResponder().name, 'mock');
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('chatSystemPrompt embeds the persona instructions verbatim', () => {
  const prompt = chatSystemPrompt('You are Dana, a skeptical buyer.');
  assert.match(prompt, /You are Dana, a skeptical buyer\./);
  assert.match(prompt, /never break the fourth wall/i);
});
