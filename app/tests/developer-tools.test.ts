import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryStore } from '@/db/memory-store';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  createWebhook,
  listWebhooks,
  deleteWebhook,
  InvalidWebhookError,
  WEBHOOK_EVENTS,
} from '@/services/developer-tools';

const USER = 'user-1';
const OTHER = 'user-2';

test('AC: generating an API key returns the plaintext once and stores only the hash', async () => {
  const store = new MemoryStore();
  const { record, plaintext } = await createApiKey(store, USER, 'Production server');

  assert.ok(plaintext.startsWith('ak_live_'), 'plaintext carries the live key prefix');
  assert.equal(record.name, 'Production server');
  assert.ok(record.keyPrefix.endsWith('…'), 'display prefix is a truncated stub');
  assert.ok(!record.keyPrefix.includes(plaintext.slice(20)), 'display stub is not the full secret');

  // The stored hash is the SHA-256 of the plaintext — the secret itself is never kept.
  assert.equal(record.keyHash, createHash('sha256').update(plaintext).digest('hex'));
  assert.notEqual(record.keyHash, plaintext);
});

test('AC: an empty name falls back to a sensible default', async () => {
  const store = new MemoryStore();
  const { record } = await createApiKey(store, USER, '   ');
  assert.equal(record.name, 'Untitled key');
});

test('AC: keys are listed per-user, newest first', async () => {
  const store = new MemoryStore();
  await createApiKey(store, USER, 'first');
  await new Promise((r) => setTimeout(r, 5)); // distinct createdAt so ordering is deterministic
  await createApiKey(store, USER, 'second');
  await createApiKey(store, OTHER, 'theirs');

  const mine = await listApiKeys(store, USER);
  assert.equal(mine.length, 2, 'only my keys are returned');
  assert.equal(mine[0].name, 'second', 'newest first');
  assert.ok(!mine.some((k) => k.name === 'theirs'), 'no cross-user leakage');
});

test('AC: revoke is a soft delete scoped to the owner', async () => {
  const store = new MemoryStore();
  const { record } = await createApiKey(store, USER, 'leaked');

  // Another user cannot revoke my key.
  assert.equal(await revokeApiKey(store, OTHER, record.id), null, 'foreign revoke is a no-op');

  const revoked = await revokeApiKey(store, USER, record.id);
  assert.ok(revoked?.revokedAt, 'owner revoke sets revokedAt');

  const keys = await listApiKeys(store, USER);
  assert.ok(keys[0].revokedAt, 'the key survives as a revoked record (audit trail)');
});

test('AC: a webhook needs a valid URL and at least one known event', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => createWebhook(store, USER, 'not-a-url', ['session.completed']), InvalidWebhookError);
  await assert.rejects(() => createWebhook(store, USER, 'https://x.com/h', []), InvalidWebhookError);
  await assert.rejects(() => createWebhook(store, USER, 'https://x.com/h', ['bogus.event']), InvalidWebhookError);
});

test('AC: creating a webhook mints a signing secret and keeps only known events', async () => {
  const store = new MemoryStore();
  const evt = WEBHOOK_EVENTS[0].id;
  const wh = await createWebhook(store, USER, 'https://app.example.com/hooks', [evt, 'bogus.event', evt]);

  assert.ok(wh.secret.startsWith('whsec_'), 'a signing secret is generated');
  assert.deepEqual(wh.events, [evt], 'unknown + duplicate events are dropped');
  assert.equal(wh.enabled, true);
});

test('AC: webhooks list per-user and delete is owner-scoped', async () => {
  const store = new MemoryStore();
  const wh = await createWebhook(store, USER, 'https://a.example.com/h', ['session.completed']);
  await createWebhook(store, OTHER, 'https://b.example.com/h', ['analysis.ready']);

  assert.equal((await listWebhooks(store, USER)).length, 1, 'only my webhooks');

  assert.equal(await deleteWebhook(store, OTHER, wh.id), false, 'foreign delete fails');
  assert.equal(await deleteWebhook(store, USER, wh.id), true, 'owner delete succeeds');
  assert.equal((await listWebhooks(store, USER)).length, 0);
});
