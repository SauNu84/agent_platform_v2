import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USE_CASES,
  getAllUseCases,
  getUseCase,
  toUseCaseLinks,
} from '@/services/use-cases';

test('use-case registry: non-empty and every entry has required fields', () => {
  assert.ok(USE_CASES.length > 0, 'at least one use case');
  for (const u of USE_CASES) {
    assert.ok(u.slug, 'use case has a slug');
    assert.ok(u.title, `use case ${u.slug} has a title`);
    assert.ok(u.navLabel, `use case ${u.slug} has a navLabel`);
    assert.ok(u.icon, `use case ${u.slug} has an icon`);
    assert.ok(u.summary, `use case ${u.slug} has a summary`);
    assert.ok(u.body.trim().length > 0, `use case ${u.slug} has a body`);
    // Body should lead with an H1 so the rendered page has a heading.
    assert.match(u.body.trimStart(), /^# /, `use case ${u.slug} body starts with an H1`);
  }
});

test('use-case registry: slugs are globally unique', () => {
  const slugs = getAllUseCases().map((u) => u.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'no duplicate slugs');
});

test('getUseCase resolves known slugs and returns null for unknown', () => {
  for (const u of getAllUseCases()) {
    assert.equal(getUseCase(u.slug)?.slug, u.slug);
  }
  assert.equal(getUseCase('does-not-exist'), null);
});

test('clinic-agent use case carries both mermaid diagrams for rendering', () => {
  const clinic = getUseCase('clinic-agent');
  assert.ok(clinic, 'clinic-agent use case exists');
  // The page must render BOTH authored diagrams (flowchart user flow + sequence).
  assert.match(clinic!.body, /```mermaid\s+flowchart/, 'has a mermaid flowchart');
  assert.match(clinic!.body, /```mermaid\s+sequenceDiagram/, 'has a mermaid sequenceDiagram');
});

test('toUseCaseLinks: lightweight links cover every use case, no bodies', () => {
  const links = toUseCaseLinks();
  assert.equal(links.length, USE_CASES.length);
  for (const l of links) {
    assert.ok(l.slug && l.title && l.navLabel && l.icon);
    assert.equal((l as unknown as Record<string, unknown>).body, undefined, 'links carry no body');
  }
});
