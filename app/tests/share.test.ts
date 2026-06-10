import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import { shareScenario, resolveShareCode, ShareNotAllowedError } from '@/services/share';
import { genShareCode, isShareCode } from '@/lib/short-code';

const PUBLIC_MD = `---
id: share-me
name: Share Me
description: A public scenario.
persona: |
  You are a friendly coach.
rubric:
  - topic: Clarity
    weight: 100
visibility: public
---
`;

const PRIVATE_MD = `---
id: secret-drill
name: Secret Drill
description: A private scenario.
persona: |
  You are a private coach.
rubric:
  - topic: Clarity
    weight: 100
visibility: private
---
`;

test('AC: share mints a stable short code that resolves back to the scenario', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, PUBLIC_MD);

  const result = await shareScenario(store, scenario.slug);
  assert.ok(result, 'a public scenario is shareable');
  assert.ok(isShareCode(result!.code), 'code is URL-safe and well-formed');
  assert.equal(result!.path, `/s/${result!.code}`);

  // /s/{code} resolves to the SAME scenario.
  const resolved = await resolveShareCode(store, result!.code);
  assert.equal(resolved?.id, scenario.id);
  assert.equal(resolved?.slug, scenario.slug);
});

test('AC: re-sharing the same scenario is idempotent — same code', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, PUBLIC_MD);

  const a = await shareScenario(store, scenario.slug);
  const b = await shareScenario(store, scenario.slug);
  assert.equal(a!.code, b!.code, 'clicking Share again returns the same link');
});

test('private scenarios are not shareable (gated)', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, PRIVATE_MD);
  await assert.rejects(() => shareScenario(store, scenario.slug), ShareNotAllowedError);
});

test('a scenario flipped to private after minting stops resolving', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, PUBLIC_MD);
  const result = await shareScenario(store, scenario.slug);

  await store.updateScenario(scenario.slug, { isPublic: false });
  assert.equal(await resolveShareCode(store, result!.code), null);
});

test('sharing a missing scenario returns null; unknown/malformed codes resolve to null', async () => {
  const store = new MemoryStore();
  assert.equal(await shareScenario(store, 'does-not-exist'), null);
  assert.equal(await resolveShareCode(store, 'ZZnotreal'), null);   // well-formed but unknown
  assert.equal(await resolveShareCode(store, 'bad code!'), null);   // malformed → no lookup
});

test('deleting a scenario removes its share link', async () => {
  const store = new MemoryStore();
  const { scenario } = await createScenarioFromMarkdown(store, PUBLIC_MD);
  const result = await shareScenario(store, scenario.slug);

  await store.deleteScenario(scenario.slug);
  assert.equal(await store.getShareLinkByCode(result!.code), null);
});

test('genShareCode produces distinct URL-safe codes', () => {
  const codes = new Set(Array.from({ length: 200 }, () => genShareCode()));
  assert.equal(codes.size, 200, 'no collisions across 200 codes');
  for (const c of codes) assert.ok(isShareCode(c));
});
