/**
 * Knowledge Base — Phase 1 (SAU-243). Covers the 5 acceptance criteria:
 *   1. create + auto-link, 2. link existing / unlink (assoc only),
 *   3. injection (deterministic, after Additional Context),
 *   4. budget guard (truncate-with-marker, no silent overflow),
 *   5. .docx / .txt / .pdf extraction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '@/db/memory-store';
import {
  assembleKnowledgeBaseContext, modelInstructions, KB_CONTEXT_CHAR_BUDGET, type KnowledgeBaseDoc,
} from '@/domain/scenario';
import { detectKbContentType, extractDocText } from '@/lib/extract-doc';
import {
  createKnowledgeBase, addDocumentFromUpload, linkToScenario, unlinkFromScenario,
  resolveKnowledgeContext, listOwnedKnowledgeBases, getOwnedKnowledgeBase, KnowledgeBaseError,
} from '@/services/knowledge-base';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures');

/** A minimal File-like for the upload service (Node test, no DOM File). */
function fakeFile(name: string, bytes: Uint8Array, type = ''): any {
  return { name, type, size: bytes.byteLength, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
}

// ── AC #4: budget guard ──────────────────────────────────────────────────────
test('assembleKnowledgeBaseContext joins docs in order under budget', () => {
  const docs: KnowledgeBaseDoc[] = [
    { filename: 'a.txt', text: 'alpha' },
    { filename: 'b.txt', text: 'beta' },
  ];
  const out = assembleKnowledgeBaseContext(docs);
  assert.equal(out.truncated, false);
  // Deterministic order: a before b.
  assert.ok(out.text.indexOf('alpha') < out.text.indexOf('beta'));
  assert.ok(out.text.includes('### a.txt') && out.text.includes('### b.txt'));
});

test('assembleKnowledgeBaseContext truncates past the budget with a visible marker', () => {
  const docs: KnowledgeBaseDoc[] = [
    { filename: 'big.txt', text: 'x'.repeat(100) },
    { filename: 'dropped.txt', text: 'y'.repeat(100) },
  ];
  const out = assembleKnowledgeBaseContext(docs, 60); // tiny budget
  assert.equal(out.truncated, true);
  assert.match(out.text, /truncated at the context budget/);
  assert.ok(!out.text.includes('dropped.txt'), 'second doc must be dropped');
});

test('budget default is 150k and empty docs yield empty block', () => {
  assert.equal(KB_CONTEXT_CHAR_BUDGET, 150_000);
  const out = assembleKnowledgeBaseContext([{ filename: 'e.txt', text: '   ' }]);
  assert.equal(out.text, '');
  assert.equal(out.truncated, false);
});

// ── AC #3: injection ordering inside the system prompt ───────────────────────
test('modelInstructions appends the KB block after Additional Context', () => {
  const rec = {
    aiInstructions: 'Be a coach.',
    metadata: { _aiDescription: 'You are Sam.', _aiContext: 'PRODUCT-CONTEXT-MARKER' },
  };
  const out = modelInstructions(rec, { knowledgeBaseText: 'KB-MARKER body' });
  assert.ok(out.includes('You are Sam.'));
  assert.ok(out.includes('## Reference context'));
  assert.ok(out.includes('## Knowledge base'));
  // KB must come AFTER Additional Context.
  assert.ok(out.indexOf('PRODUCT-CONTEXT-MARKER') < out.indexOf('KB-MARKER body'));
});

test('modelInstructions omits the KB block when no text', () => {
  const out = modelInstructions({ aiInstructions: 'hi' });
  assert.ok(!out.includes('## Knowledge base'));
});

// ── AC #5: format detection + extraction ─────────────────────────────────────
test('detectKbContentType resolves by extension and mime', () => {
  assert.equal(detectKbContentType('a.PDF'), 'pdf');
  assert.equal(detectKbContentType('a.docx'), 'docx');
  assert.equal(detectKbContentType('a.txt'), 'txt');
  assert.equal(detectKbContentType('noext', 'text/plain'), 'txt');
  assert.equal(detectKbContentType('weird.bin'), null);
});

test('extractDocText: .txt passthrough', async () => {
  const text = await extractDocText(new TextEncoder().encode('hello   world\n\n\n\nbye'), 'txt');
  assert.equal(text, 'hello world\n\nbye');
});

test('extractDocText: .docx via mammoth (real fixture)', async () => {
  const bytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, 'kb-sample.docx')));
  const text = await extractDocText(bytes, 'docx');
  assert.match(text, /Refund policy/);
  assert.match(text, /Escalate billing disputes/);
});

// ── AC #1 + #2 + #3 end-to-end through the store/service ─────────────────────
test('create KB, add docs, link to scenario, inject in order; unlink keeps KB', async () => {
  const store = new MemoryStore();
  const owner = { ownerUserId: 'user-1' };
  const actor = { userId: 'user-1', isAdmin: false };

  // A scenario to link to.
  const sc = await store.createScenario(
    { slug: 'kb-sc', name: 'KB Scenario', description: null, aiInstructions: 'Coach.', rubric: [], isPublic: true, voiceName: 'alloy', languageCode: 'en-US', tools: [], metadata: {} } as any,
    owner,
  );

  // AC #1: create + add docs (two, to assert deterministic order).
  const kb = await createKnowledgeBase(store, { title: 'Playbook', description: 'sales' }, owner);
  await addDocumentFromUpload(store, kb.id, fakeFile('first.txt', new TextEncoder().encode('FIRST-DOC')), actor);
  await addDocumentFromUpload(store, kb.id, fakeFile('second.txt', new TextEncoder().encode('SECOND-DOC')), actor);

  await linkToScenario(store, sc.id, kb.id);

  // AC #3: resolution yields docs in upload order, foldable into the prompt.
  const resolved = await resolveKnowledgeContext(store, sc.id);
  assert.equal(resolved.docs, 2);
  assert.ok(resolved.text.indexOf('FIRST-DOC') < resolved.text.indexOf('SECOND-DOC'));

  // AC #2: linked list shows it; unlink removes the association but not the KB.
  const linked = await store.listScenarioKnowledgeBases(sc.id);
  assert.equal(linked.length, 1);
  const removed = await unlinkFromScenario(store, sc.id, kb.id);
  assert.equal(removed, true);
  assert.equal((await store.listScenarioKnowledgeBases(sc.id)).length, 0);
  assert.ok(await store.getKnowledgeBase(kb.id), 'KB survives unlink');
});

test('ownership: a non-owner cannot read or upload to someone else’s KB', async () => {
  const store = new MemoryStore();
  const kb = await createKnowledgeBase(store, { title: 'Mine' }, { ownerUserId: 'user-1' });
  const intruder = { userId: 'user-2', isAdmin: false };
  await assert.rejects(() => getOwnedKnowledgeBase(store, kb.id, intruder), KnowledgeBaseError);
  // Owner list excludes others' KBs; admin sees all.
  assert.equal((await listOwnedKnowledgeBases(store, intruder)).length, 0);
  assert.equal((await listOwnedKnowledgeBases(store, { userId: 'x', isAdmin: true })).length, 1);
});

test('unsupported format and oversize are rejected with KnowledgeBaseError', async () => {
  const store = new MemoryStore();
  const kb = await createKnowledgeBase(store, { title: 'K' }, { ownerUserId: 'u' });
  const actor = { userId: 'u', isAdmin: false };
  await assert.rejects(
    () => addDocumentFromUpload(store, kb.id, fakeFile('bad.bin', new Uint8Array([1, 2, 3])), actor),
    /Unsupported file type/,
  );
});
