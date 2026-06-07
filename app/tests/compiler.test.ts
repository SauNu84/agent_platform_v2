import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScenarioContent, renderScenarioToMarkdown, ScenarioCompileError, sha256 } from '@/compiler/compile';

const GOOD = `---
id: sales-objection-handling
name: Sales Objection Handling
description: Practice handling a skeptical buyer.
persona: |
  You are a skeptical enterprise buyer.
rubric:
  - topic: Discovery
    weight: 60
  - topic: Tone
    weight: 40
voice:
  name: alloy
  language: en-US
tools: [slides, whiteboard]
visibility: public
metadata:
  role: Sales
  difficulty: intermediate
---
Body briefing the agent may use.
`;

test('compiles a well-formed scenario .md into the canonical record', () => {
  const { record, contentHash } = compileScenarioContent(GOOD);
  assert.equal(record.slug, 'sales-objection-handling');
  assert.equal(record.name, 'Sales Objection Handling');
  assert.equal(record.isPublic, true);
  assert.equal(record.voiceName, 'alloy');
  assert.equal(record.languageCode, 'en-US');
  assert.equal(record.rubric.length, 2);
  assert.equal(record.rubric[0].topic, 'Discovery');
  // named tools resolve to full ToolDefinitions
  assert.deepEqual(record.tools.map((t) => t.name), ['slides', 'whiteboard']);
  assert.equal(record.tools[0].sideEffect, 'ui');
  // body is appended to persona as reference briefing
  assert.match(record.aiInstructions, /skeptical enterprise buyer/);
  assert.match(record.aiInstructions, /Reference briefing/);
  assert.match(record.aiInstructions, /Body briefing/);
  assert.equal(record.metadata.role, 'Sales');
  assert.equal(contentHash, sha256(GOOD));
});

test('round-trip: compile(render(compile(md))) is stable', () => {
  const first = compileScenarioContent(GOOD).record;
  const md = renderScenarioToMarkdown(first);
  const second = compileScenarioContent(md).record;
  assert.deepEqual(second, first);
});

test('rejects frontmatter missing required fields (never reaches DB)', () => {
  const bad = `---\nname: No Id Or Persona\n---\n`;
  assert.throws(() => compileScenarioContent(bad), (e: unknown) => {
    assert.ok(e instanceof ScenarioCompileError);
    assert.match((e as Error).message, /id|persona/);
    return true;
  });
});

test('rejects a non-kebab slug', () => {
  const bad = `---\nid: Not A Slug\nname: X\npersona: hi\n---\n`;
  assert.throws(() => compileScenarioContent(bad), ScenarioCompileError);
});

test('rejects an unknown named tool', () => {
  const bad = `---\nid: x\nname: X\npersona: hi\ntools: [telepathy]\n---\n`;
  assert.throws(() => compileScenarioContent(bad), (e: unknown) => {
    assert.match((e as Error).message, /unknown tool "telepathy"/);
    return true;
  });
});

test('accepts ai_instructions alias and slug alias', () => {
  const md = `---\nslug: aliased\nname: Aliased\nai_instructions: be helpful\n---\n`;
  const { record } = compileScenarioContent(md);
  assert.equal(record.slug, 'aliased');
  assert.equal(record.aiInstructions, 'be helpful');
  assert.equal(record.isPublic, false); // defaults to private
});
