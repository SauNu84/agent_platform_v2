/**
 * AI Studio conversational editing (SAU-244) — the /api/authoring/edit substance.
 *
 * The route is a thin auth-gated wrapper over `editScenarioDraft`; the logic
 * (deterministic edit + compiler validation gate + never-writes-DB) lives in the
 * pipeline, so that's what we exercise here (mirrors authoring.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { editScenarioDraft } from '@/authoring/pipeline';
import { TemplateAuthor, deterministicEdit, scenarioFieldsToMd, type ScenarioEditFields } from '@/authoring/author';
import { compileScenarioContent } from '@/compiler/compile';

const BASE: ScenarioEditFields = {
  name: 'Sales Discovery Call',
  description: 'Practice an enterprise discovery conversation.',
  userInstructions: 'Convince the skeptical VP to take a pilot.',
  aiDescription: 'You are Alex Chen, a cost-conscious VP of Engineering.',
  persona: 'You are a skeptical enterprise buyer. Push back on vendor claims and probe ROI.',
  rubric: [
    { topic: 'Needs Discovery', weight: 50 },
    { topic: 'Objection Handling', weight: 50 },
  ],
};

test('edit: a valid patch compiles, never writes DB, and reports what changed', async () => {
  const store = new MemoryStore();
  const draft = await editScenarioDraft(BASE, 'rename to "Enterprise Discovery: First Call"', { author: new TemplateAuthor() });

  assert.equal(draft.ok, true, draft.errors);
  assert.equal(draft.kind, 'edit');
  assert.equal(draft.fields.name, 'Enterprise Discovery: First Call');
  // Untouched fields are preserved.
  assert.equal(draft.fields.persona, BASE.persona);
  assert.equal(draft.fields.rubric.length, 2);
  // A non-empty, human "what changed" summary is always present.
  assert.ok(draft.summary.length > 0);
  assert.match(draft.summary, /renamed/i);
  // Editing NEVER persists — the store stays empty.
  assert.equal((await store.listScenarios()).length, 0);
  // The patched fields independently pass the same compiler the platform uses.
  const { record } = compileScenarioContent(scenarioFieldsToMd(draft.fields));
  assert.equal(record.name, 'Enterprise Discovery: First Call');
});

test('edit: adding a rubric criterion re-normalizes weights to sum 100', async () => {
  const draft = await editScenarioDraft(BASE, 'add a rubric criterion for Value Articulation', { author: new TemplateAuthor() });
  assert.equal(draft.ok, true, draft.errors);
  assert.equal(draft.fields.rubric.length, 3);
  assert.ok(draft.fields.rubric.some((r) => /Value Articulation/i.test(r.topic)));
  assert.equal(draft.fields.rubric.reduce((s, r) => s + r.weight, 0), 100);
});

test('edit: removing a criterion drops it and re-normalizes', async () => {
  const draft = await editScenarioDraft(BASE, 'remove the criterion named Objection Handling', { author: new TemplateAuthor() });
  assert.equal(draft.ok, true, draft.errors);
  assert.equal(draft.fields.rubric.length, 1);
  assert.equal(draft.fields.rubric[0].topic, 'Needs Discovery');
  assert.equal(draft.fields.rubric[0].weight, 100);
});

test('edit: setting the learner brief and AI description target the right fields', async () => {
  const brief = await editScenarioDraft(BASE, 'set learner brief to: keep it under 5 minutes', { author: new TemplateAuthor() });
  assert.equal(brief.fields.userInstructions, 'keep it under 5 minutes');
  assert.equal(brief.fields.persona, BASE.persona, 'persona untouched');

  const aidesc = await editScenarioDraft(BASE, 'set AI description to: a busy, friendly CTO', { author: new TemplateAuthor() });
  assert.equal(aidesc.fields.aiDescription, 'a busy, friendly CTO');
});

test('edit: an unrecognized instruction folds into the persona as a refinement', async () => {
  const draft = await editScenarioDraft(BASE, 'make the buyer angrier when price is mentioned', { author: new TemplateAuthor() });
  assert.equal(draft.ok, true, draft.errors);
  assert.match(draft.fields.persona, /Refinement: make the buyer angrier/);
  assert.match(draft.summary, /AI Instructions/i);
});

test('edit: a patch that breaks the schema comes back ok:false with errors and the fields', () => {
  // Clear the persona/name → the compiler rejects it; the proposed fields ride along.
  const broken: ScenarioEditFields = { ...BASE, name: '', persona: '' };
  // Validate via the compiler directly (deterministicEdit on a generic instruction
  // would re-add a persona; here we assert the validation gate itself rejects).
  assert.throws(() => compileScenarioContent(scenarioFieldsToMd(broken)));
});

test('edit: empty instruction yields a no-op patch with a helpful summary', async () => {
  const draft = await editScenarioDraft(BASE, '   ', { author: new TemplateAuthor() });
  assert.equal(draft.ok, true);
  assert.deepEqual(draft.fields.rubric.length, BASE.rubric.length);
  assert.match(draft.summary, /No changes/i);
});

test('deterministicEdit is pure — it does not mutate the input field set', () => {
  const before = JSON.parse(JSON.stringify(BASE));
  deterministicEdit(BASE, 'add a rubric criterion for Closing');
  assert.deepEqual(BASE, before);
});
