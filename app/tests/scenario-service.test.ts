import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import {
  listScenarios, getScenario, createScenarioFromMarkdown, createScenarioFromJson,
  updateScenario, deleteScenario, ScenarioCompileError,
} from '@/services/scenarios';
import { isStale } from '@/compiler/compile';

const MD = `---
id: crud-demo
name: CRUD Demo
persona: be helpful
voice: { name: alloy, language: en-US }
visibility: public
metadata: { role: PM }
---
`;

test('CRUD lifecycle via the content-as-code + JSON paths', async () => {
  const store = new MemoryStore();

  // create from markdown (compile-upsert) + content_source recorded
  const { scenario, created } = await createScenarioFromMarkdown(store, MD, { repoPath: 'content/scenarios/crud-demo.md' });
  assert.equal(created, true);
  assert.equal(scenario.slug, 'crud-demo');
  const src = await store.getContentSource('scenario', scenario.id);
  assert.ok(src, 'content_source should be recorded');
  assert.equal(src!.repoPath, 'content/scenarios/crud-demo.md');

  // re-compiling the same MD upserts (not a duplicate)
  const again = await createScenarioFromMarkdown(store, MD);
  assert.equal(again.created, false);
  assert.equal((await listScenarios(store)).length, 1);

  // get + filter
  assert.equal((await getScenario(store, 'crud-demo'))?.name, 'CRUD Demo');
  assert.equal((await listScenarios(store, { isPublic: true })).length, 1);
  assert.equal((await listScenarios(store, { metadata: { role: 'PM' } })).length, 1);
  assert.equal((await listScenarios(store, { metadata: { role: 'SWE' } })).length, 0);

  // update
  const updated = await updateScenario(store, 'crud-demo', { name: 'Renamed', visibility: 'private' });
  assert.equal(updated?.name, 'Renamed');
  assert.equal(updated?.isPublic, false);

  // delete
  assert.equal(await deleteScenario(store, 'crud-demo'), true);
  assert.equal(await getScenario(store, 'crud-demo'), null);
  assert.equal(await deleteScenario(store, 'crud-demo'), false);
});

test('JSON create validates against the same schema', async () => {
  const store = new MemoryStore();
  const ok = await createScenarioFromJson(store, { id: 'json-demo', name: 'JSON', persona: 'hi', visibility: 'public' });
  assert.equal(ok.slug, 'json-demo');
  await assert.rejects(
    () => createScenarioFromJson(store, { name: 'missing id and persona' }),
    ScenarioCompileError,
  );
  await assert.rejects(
    () => createScenarioFromJson(store, { id: 'json-demo', name: 'dup', persona: 'hi' }),
    /already exists/,
  );
});

test('drift detection flags an edited source file', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, MD);
  // Write the same + a drifted version to temp files and check isStale.
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'scn-'));
  const same = join(dir, 'same.md');
  const drift = join(dir, 'drift.md');
  writeFileSync(same, MD);
  writeFileSync(drift, MD + '\nedited body\n');
  assert.equal(await isStale(same, store, scenario.id), false);
  assert.equal(await isStale(drift, store, scenario.id), true);
});

// SAU-238: Description for AI feeds the model prompt; User Instruction does not.
import { modelInstructions, toCompiledScenario } from '@/domain/scenario';

test('SAU-238: modelInstructions prepends _aiDescription and excludes _userInstructions', () => {
  const rec = {
    aiInstructions: '## Role\nAsk probing questions.',
    metadata: { _aiDescription: 'You are Alex Chen, a skeptical VP.', _userInstructions: 'Your goal: win the deal.' },
  };
  const sys = modelInstructions(rec);
  assert.ok(sys.startsWith('You are Alex Chen, a skeptical VP.'), 'AI description should lead the prompt');
  assert.ok(sys.includes('Ask probing questions.'), 'detailed AI instructions should follow');
  assert.ok(!sys.includes('win the deal'), 'user instruction must NOT reach the model');
});

test('SAU-238: a JSON-created scenario carries both fields in metadata and only _aiDescription reaches the model', async () => {
  const store = new MemoryStore();
  const scenario = await createScenarioFromJson(store, {
    id: 'instr-fields', name: 'Instr Fields', persona: 'Stay in character.', visibility: 'public',
    metadata: { _userInstructions: 'Convince the buyer.', _aiDescription: 'You are a tough buyer.' },
  });
  assert.equal(scenario.metadata._userInstructions, 'Convince the buyer.');
  assert.equal(scenario.metadata._aiDescription, 'You are a tough buyer.');
  // The voice seam's view (what the realtime token route sends) includes the description, not the user brief.
  const compiled = toCompiledScenario(scenario);
  assert.ok(compiled.aiInstructions.includes('You are a tough buyer.'));
  assert.ok(!compiled.aiInstructions.includes('Convince the buyer.'));
});

// SAU-238 ask #6: AI model registry.
import { aiModelLabel, isAvailableModel, AI_MODELS, DEFAULT_AI_MODEL } from '@/lib/ai-models';

test('SAU-238: AI model registry — OpenAI is the available default; unknown falls back', () => {
  assert.equal(DEFAULT_AI_MODEL, 'openai-realtime');
  assert.equal(isAvailableModel('openai-realtime'), true);
  assert.equal(isAvailableModel('anthropic-claude'), false); // future, not wired yet
  assert.equal(isAvailableModel('nope'), false);
  assert.match(aiModelLabel('openai-realtime'), /OpenAI/);
  assert.equal(aiModelLabel('unknown-id'), aiModelLabel(DEFAULT_AI_MODEL)); // safe fallback
  assert.ok(AI_MODELS.some((m) => m.available), 'at least one model must be runnable');
});
