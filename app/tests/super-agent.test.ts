import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromJson, updateScenario, ScenarioCompileError } from '@/services/scenarios';
import { modelInstructions, toCompiledScenario, type ScenarioRecord } from '@/domain/scenario';
import {
  parseSuperAgentConfig, safeParseSuperAgentConfig, compileSuperAgentInstructions,
  superAgentToolNames, isSuperAgent, SuperAgentConfigError, AGENT_TYPE_OPTIONS,
} from '@/domain/super-agent';

const VALID = {
  supervisor: {
    role: 'A clinic front-desk coordinator.',
    goal: 'Route every caller to a booked outcome.',
    instructions: 'Start with Intake; switch to Scheduler once a service is chosen.',
    commonInstructions: 'Be warm. Never give medical advice.',
  },
  subAgents: [
    { name: 'Intake', instructions: 'Gather the reason for the visit.', tools: ['check_availability'] },
    { name: 'Scheduler', instructions: 'Book the confirmed slot.', tools: ['check_availability', 'create_appointment'], model: 'openai-realtime' },
  ],
};

test('SAU-307: parseSuperAgentConfig accepts a valid config and defaults', () => {
  const cfg = parseSuperAgentConfig(VALID);
  assert.equal(cfg.subAgents.length, 2);
  assert.equal(cfg.supervisor.commonInstructions, 'Be warm. Never give medical advice.');
  // commonInstructions defaults to '' when omitted.
  const noCommon = parseSuperAgentConfig({ ...VALID, supervisor: { ...VALID.supervisor, commonInstructions: undefined } });
  assert.equal(noCommon.supervisor.commonInstructions, '');
});

test('SAU-307: parseSuperAgentConfig rejects missing supervisor fields and empty sub-agents', () => {
  assert.throws(() => parseSuperAgentConfig({ supervisor: { role: '', goal: 'g', instructions: 'i' }, subAgents: [{ name: 'A', instructions: 'x' }] }), SuperAgentConfigError);
  assert.throws(() => parseSuperAgentConfig({ supervisor: VALID.supervisor, subAgents: [] }), /at least one sub-agent/);
  assert.throws(() => parseSuperAgentConfig({ supervisor: VALID.supervisor, subAgents: [{ name: '', instructions: 'x' }] }), /name/);
});

test('SAU-307: safeParse returns null on bad input (runtime stays resilient)', () => {
  assert.equal(safeParseSuperAgentConfig(undefined), null);
  assert.equal(safeParseSuperAgentConfig({ nope: true }), null);
  assert.ok(safeParseSuperAgentConfig(VALID));
});

test('SAU-307: compiled supervisor prompt carries role, goal, strategy, common, and every sub-agent', () => {
  const sys = compileSuperAgentInstructions(parseSuperAgentConfig(VALID));
  assert.ok(/SUPERVISOR/.test(sys), 'declares it is a supervisor');
  assert.ok(sys.includes('A clinic front-desk coordinator.'), 'role');
  assert.ok(sys.includes('Route every caller to a booked outcome.'), 'goal');
  assert.ok(sys.includes('switch to Scheduler'), 'switching strategy');
  assert.ok(sys.includes('Never give medical advice.'), 'common instructions');
  assert.ok(sys.includes('### 1. Intake') && sys.includes('### 2. Scheduler'), 'each sub-agent listed');
  assert.ok(sys.includes('Preferred model: openai-realtime'), 'sub-agent model surfaced');
  assert.ok(/Switch silently/.test(sys), 'operating rules present');
});

test('SAU-307: superAgentToolNames is the deduped union in order', () => {
  assert.deepEqual(superAgentToolNames(parseSuperAgentConfig(VALID)), ['check_availability', 'create_appointment']);
});

test('SAU-307: modelInstructions routes a super scenario to the compiled prompt, not the persona', () => {
  const rec = {
    aiInstructions: 'PERSONA-FALLBACK-TEXT that must not be used.',
    metadata: { _agentType: 'super', _superAgent: VALID, _aiContext: 'Clinic opens 9-5.' },
  };
  const sys = modelInstructions(rec);
  assert.ok(!sys.includes('PERSONA-FALLBACK-TEXT'), 'single-agent persona is NOT used for a super agent');
  assert.ok(sys.includes('A clinic front-desk coordinator.'), 'supervisor prompt leads');
  // Additional Context still folds in (shared with the default path).
  assert.ok(/Reference context/.test(sys) && sys.includes('Clinic opens 9-5.'), 'context still appended');
});

test('SAU-307: a malformed super config falls back to the single-agent prompt at runtime', () => {
  const rec = { aiInstructions: 'Be a helpful single agent.', metadata: { _agentType: 'super', _superAgent: { junk: true } } };
  const sys = modelInstructions(rec);
  assert.ok(sys.includes('Be a helpful single agent.'), 'falls back to persona when config is unusable');
});

test('SAU-307: toCompiledScenario exposes the UNION of sub-agent tools', () => {
  const rec: ScenarioRecord = {
    id: 'x', slug: 'super-clinic', name: 'Super Clinic', description: null,
    aiInstructions: 'fallback', rubric: [], isPublic: false,
    voiceName: 'alloy', languageCode: 'en-US', tools: [],
    metadata: { _agentType: 'super', _superAgent: VALID },
    ownerUserId: null, createdAt: '', updatedAt: '',
  };
  const compiled = toCompiledScenario(rec);
  const names = compiled.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['check_availability', 'create_appointment']);
});

test('SAU-307: createScenarioFromJson persists a valid super agent and rejects invalid ones', async () => {
  const store = new MemoryStore();
  const ok = await createScenarioFromJson(store, {
    id: 'super-ok', name: 'Super OK', persona: 'fallback persona', visibility: 'private',
    metadata: { _agentType: 'super', _superAgent: VALID },
  });
  assert.equal(ok.metadata._agentType, 'super');
  assert.ok(isSuperAgent(ok.metadata));

  // Missing sub-agents → rejected like any invalid scenario input.
  await assert.rejects(() => createScenarioFromJson(store, {
    id: 'super-bad', name: 'Bad', persona: 'p', metadata: { _agentType: 'super', _superAgent: { supervisor: VALID.supervisor, subAgents: [] } },
  }), ScenarioCompileError);

  // Unknown tool name → rejected (same registry rule as default agents).
  await assert.rejects(() => createScenarioFromJson(store, {
    id: 'super-badtool', name: 'BadTool', persona: 'p',
    metadata: { _agentType: 'super', _superAgent: { supervisor: VALID.supervisor, subAgents: [{ name: 'A', instructions: 'x', tools: ['nonesuch'] }] } },
  }), /nonesuch/);
});

test('SAU-307: updateScenario applies the write-time gate (D3 holds on the update path too)', async () => {
  const store = new MemoryStore();
  await createScenarioFromJson(store, {
    id: 'super-upd', name: 'Super Upd', persona: 'fallback persona', visibility: 'private',
    metadata: { _agentType: 'super', _superAgent: VALID },
  });

  // A valid super config updates cleanly.
  const ok = await updateScenario(store, 'super-upd', {
    metadata: { _agentType: 'super', _superAgent: { ...VALID, supervisor: { ...VALID.supervisor, goal: 'Updated goal.' } } },
  });
  assert.ok(ok && isSuperAgent(ok.metadata));

  // A malformed super config is rejected on update, not silently persisted to
  // degrade to the single-agent prompt at runtime.
  await assert.rejects(() => updateScenario(store, 'super-upd', {
    metadata: { _agentType: 'super', _superAgent: { supervisor: VALID.supervisor, subAgents: [] } },
  }), ScenarioCompileError);

  // An unknown tool name is rejected on update too (same registry rule as create).
  await assert.rejects(() => updateScenario(store, 'super-upd', {
    metadata: { _agentType: 'super', _superAgent: { supervisor: VALID.supervisor, subAgents: [{ name: 'A', instructions: 'x', tools: ['nonesuch'] }] } },
  }), /nonesuch/);
});

test('SAU-307: agent-type options expose Default + Super available, Composite + Meeting deferred', () => {
  const byId = Object.fromEntries(AGENT_TYPE_OPTIONS.map((o) => [o.id, o]));
  assert.equal(byId.default.available, true);
  assert.equal(byId.super.available, true);
  assert.equal(byId.composite.available, false);
  assert.equal(byId.meeting.available, false);
});
