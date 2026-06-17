import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectImportableAgents, buildSubAgentFromScenario, type ImportableAgent,
} from '@/services/super-agent-import';
import {
  parseSuperAgentConfig, compileSuperAgentInstructions, assertSuperAgentWithinLimits,
} from '@/domain/super-agent';

/** A user-authored Default agent with a mix of supported + unsupported tools. */
const DEFAULT_AGENT: ImportableAgent = {
  slug: 'clinic-intake',
  name: 'Clinic Intake',
  aiInstructions: 'You gather the reason for the visit and collect insurance details.',
  tools: [{ name: 'check_availability' }, { name: 'create_appointment' }, { name: 'made_up_tool' }],
  metadata: { _source: 'user', _model: 'openai-realtime' },
};

test('SAU-327: selectImportableAgents keeps the author\'s Default agents only', () => {
  const scenarios = [
    DEFAULT_AGENT,
    { slug: 'featured-coach', name: 'Featured Coach', aiInstructions: 'x', tools: [], metadata: { _source: 'seed' } },
    { slug: 'my-supervisor', name: 'My Supervisor', aiInstructions: 'x', tools: [], metadata: { _source: 'user', _agentType: 'super' } },
    { slug: 'editing-now', name: 'Editing Now', aiInstructions: 'x', tools: [], metadata: { _source: 'user' } },
  ];
  const out = selectImportableAgents<ImportableAgent>(scenarios, 'editing-now');
  // Drops the seeded (not-mine), the Super Agent, and the scenario being edited.
  assert.deepEqual(out.map((s) => s.slug), ['clinic-intake']);
});

test('SAU-327: buildSubAgentFromScenario maps fields and drops unsupported tools', () => {
  const sub = buildSubAgentFromScenario(DEFAULT_AGENT);
  assert.equal(sub.name, 'Clinic Intake');
  assert.equal(sub.instructions, DEFAULT_AGENT.aiInstructions);
  assert.deepEqual(sub.tools, ['check_availability', 'create_appointment']);
  assert.deepEqual(sub.droppedTools, ['made_up_tool']); // not in the sub-agent registry
  assert.equal(sub.model, 'openai-realtime');
});

test('SAU-327: name falls back to slug, model defaults to empty when absent', () => {
  const sub = buildSubAgentFromScenario({
    slug: 'no-name', name: '   ', aiInstructions: 'do a thing', tools: [], metadata: {},
  });
  assert.equal(sub.name, 'no-name');
  assert.equal(sub.model, '');
  assert.deepEqual(sub.tools, []);
  assert.deepEqual(sub.droppedTools, []);
});

test('SAU-327: an imported sub-agent yields a config that parses, validates, and compiles in', () => {
  const sub = buildSubAgentFromScenario(DEFAULT_AGENT);
  const cfg = parseSuperAgentConfig({
    supervisor: {
      role: 'Front-desk coordinator', goal: 'Book the caller', instructions: 'Start with intake.',
    },
    // Only the supported tools survive into the saved config (droppedTools is UI-only).
    subAgents: [{ name: sub.name, instructions: sub.instructions, tools: sub.tools, ...(sub.model ? { model: sub.model } : {}) }],
  });
  assert.doesNotThrow(() => assertSuperAgentWithinLimits(cfg));
  const prompt = compileSuperAgentInstructions(cfg);
  assert.ok(prompt.includes('Clinic Intake'), 'compiled supervisor prompt includes the imported sub-agent');
  assert.ok(prompt.includes('check_availability'));
});

test('SAU-327: import is a snapshot — mutating the result never reaches the source agent', () => {
  const source: ImportableAgent = {
    slug: 'src', name: 'Src', aiInstructions: 'orig', tools: [{ name: 'slides' }], metadata: { _model: 'openai-realtime' },
  };
  const sub = buildSubAgentFromScenario(source);
  // Edit the snapshot the way the form would.
  sub.name = 'Renamed';
  sub.instructions = 'rewritten';
  sub.tools.push('whiteboard');
  // The source agent is untouched.
  assert.equal(source.name, 'Src');
  assert.equal(source.aiInstructions, 'orig');
  assert.deepEqual(source.tools, [{ name: 'slides' }]);
});
