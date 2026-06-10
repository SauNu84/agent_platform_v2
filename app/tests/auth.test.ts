/**
 * Auth core: password hashing, session lifecycle, and actor resolution (role +
 * capabilities) over the in-memory store. Hermetic — no live Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { hashPassword, verifyPassword } from '@/auth/password';
import { login, logout, resolveActor } from '@/auth/session';
import { seedTestUsers, TEST_USER_PASSWORD } from '@/db/seed-users';

test('password hash verifies the right password and rejects the wrong one', async () => {
  const hash = await hashPassword('s3cret-pw');
  assert.equal(hash.startsWith('scrypt$'), true);
  assert.equal(await verifyPassword('s3cret-pw', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  // distinct salts → distinct hashes for the same password
  const hash2 = await hashPassword('s3cret-pw');
  assert.notEqual(hash, hash2);
});

test('login mints a session; resolveActor returns identity + role + capabilities', async () => {
  const store = new MemoryStore();
  await seedTestUsers(store);

  const session = await login(store, 'user@demo.test', TEST_USER_PASSWORD);
  assert.ok(session, 'expected a session for valid creds');

  const actor = await resolveActor(store, session!.token);
  assert.ok(actor);
  assert.equal(actor!.email, 'user@demo.test');
  assert.equal(actor!.role, 'user');
  assert.deepEqual([...actor!.capabilities].sort(), ['author_content', 'practice']);
  assert.equal(actor!.isAdmin, false);
});

test('login rejects bad credentials and is case-insensitive on email', async () => {
  const store = new MemoryStore();
  await seedTestUsers(store);
  assert.equal(await login(store, 'user@demo.test', 'nope'), null);
  assert.equal(await login(store, 'nobody@demo.test', TEST_USER_PASSWORD), null);
  // email normalized to lower-case at lookup
  const s = await login(store, 'USER@DEMO.TEST', TEST_USER_PASSWORD);
  assert.ok(s);
});

test('admin resolves as admin (platform_admin); operator gets the privacy step-up caps', async () => {
  const store = new MemoryStore();
  await seedTestUsers(store);

  const admin = await resolveActor(store, (await login(store, 'admin@demo.test', TEST_USER_PASSWORD))!.token);
  assert.equal(admin!.isAdmin, true);
  assert.equal(admin!.capabilities.includes('platform_admin'), true);
  assert.equal(admin!.capabilities.includes('manage_billing'), true);

  const op = await resolveActor(store, (await login(store, 'operator@demo.test', TEST_USER_PASSWORD))!.token);
  assert.equal(op!.isAdmin, false);
  assert.equal(op!.capabilities.includes('assign_to_users'), true);
  assert.equal(op!.capabilities.includes('view_identified_results'), true);
  assert.equal(op!.capabilities.includes('manage_org_members'), false);
});

test('logout revokes the session; expired sessions resolve to null', async () => {
  const store = new MemoryStore();
  await seedTestUsers(store);
  const session = (await login(store, 'user@demo.test', TEST_USER_PASSWORD))!;

  await logout(store, session.token);
  assert.equal(await resolveActor(store, session.token), null);

  // an expired token is treated as logged-out
  const user = await store.getUserByEmail('user@demo.test');
  await store.createAuthSession('expired-token', user!.id, new Date(Date.now() - 1000).toISOString());
  assert.equal(await resolveActor(store, 'expired-token'), null);
});
