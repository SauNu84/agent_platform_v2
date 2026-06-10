import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown, createScenarioFromJson, listScenarios } from '@/services/scenarios';
import { buildRemixConfig, remixSlug } from '@/services/remix';

const SOURCE_MD = `---
id: enterprise-discovery
name: Sales Discovery Call
description: Practice enterprise sales discovery with a skeptical buyer.
persona: |
  You are a skeptical VP-level enterprise buyer. Push back on vendor claims.
rubric:
  - topic: Needs Discovery
    weight: 60
  - topic: Objection Handling
    weight: 40
voice: { name: verse, language: en-GB }
visibility: public
metadata: { role: Sales, difficulty: Hard }
---
`;

test('buildRemixConfig clones the full config into an editable, user-owned draft', async () => {
  const store = new MemoryStore();
  const { scenario: source } = await createScenarioFromMarkdown(store, SOURCE_MD);

  const draft = buildRemixConfig(source);

  // name is suffixed; slug is fresh (won't collide with the source).
  assert.equal(draft.name, 'Sales Discovery Call (remix)');
  assert.equal(draft.slug, 'enterprise-discovery-remix');
  assert.notEqual(draft.slug, source.slug);

  // config carried faithfully: persona, rubric, description, voice.
  assert.equal(draft.persona, source.aiInstructions);
  assert.deepEqual(draft.rubric, source.rubric);
  assert.equal(draft.description, source.description);
  assert.deepEqual(draft.voice, { name: 'verse', language: 'en-GB' });

  // a remix is a private draft the user owns, with provenance + carried facets.
  assert.equal(draft.visibility, 'private');
  assert.equal(draft.metadata._source, 'user');
  assert.equal(draft.metadata._remixedFrom, 'enterprise-discovery');
  assert.equal(draft.metadata.role, 'Sales');
  assert.equal(draft.metadata.difficulty, 'Hard');
});

test('AC: remix creates a new editable scenario that shows under "My Scenarios" and leaves the source untouched', async () => {
  const store = new MemoryStore();
  const { scenario: source } = await createScenarioFromMarkdown(store, SOURCE_MD);

  // The create form submits the cloned draft to POST /api/scenarios (createScenarioFromJson).
  const draft = buildRemixConfig(source);
  const created = await createScenarioFromJson(store, {
    id: draft.slug,
    name: draft.name,
    description: draft.description ?? undefined,
    persona: draft.persona,
    rubric: draft.rubric,
    visibility: draft.visibility,
    voice: draft.voice,
    metadata: draft.metadata,
  });

  // a distinct, persisted scenario seeded from the source.
  assert.equal(created.slug, 'enterprise-discovery-remix');
  assert.equal(created.aiInstructions, source.aiInstructions);
  assert.equal(created.isPublic, false);
  assert.equal(created.voiceName, 'verse');
  assert.equal(created.metadata._remixedFrom, 'enterprise-discovery');

  // shows up under the Library "My Scenarios" tab (metadata._source = 'user')...
  const mine = (await listScenarios(store)).filter((s) => s.metadata._source === 'user');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].slug, created.slug);

  // ...and the original is unchanged (still public, no remix metadata).
  const original = await store.getScenarioBySlug('enterprise-discovery');
  assert.equal(original?.isPublic, true);
  assert.equal(original?.metadata._remixedFrom, undefined);

  // editable later: a PATCH-style update succeeds on the remixed draft.
  const edited = await store.updateScenario(created.slug, { name: 'My Custom Discovery' });
  assert.equal(edited?.name, 'My Custom Discovery');
});

test('remixed drafts remain editable and re-remixable (provenance does not stack)', async () => {
  const store = new MemoryStore();
  const { scenario: source } = await createScenarioFromMarkdown(store, SOURCE_MD);
  const first = buildRemixConfig(source);
  const firstSaved = await createScenarioFromJson(store, {
    id: first.slug, name: first.name, persona: first.persona,
    rubric: first.rubric, visibility: first.visibility, metadata: first.metadata,
  });

  // Remixing a remix points _remixedFrom at the immediate source (no chain buildup).
  const second = buildRemixConfig(firstSaved);
  assert.equal(second.slug, 'enterprise-discovery-remix-remix');
  assert.equal(second.metadata._remixedFrom, firstSaved.slug);
  assert.equal(second.metadata._source, 'user');
});

test('remixSlug stays kebab-valid and bounded', () => {
  assert.equal(remixSlug('a-scenario'), 'a-scenario-remix');
  assert.match(remixSlug('x'.repeat(80)), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(remixSlug('x'.repeat(80)).length <= 60);
});
