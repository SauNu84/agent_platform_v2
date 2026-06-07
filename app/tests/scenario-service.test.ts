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
