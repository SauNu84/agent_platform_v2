/**
 * RBAC permission + ownership enforcement at the API/guard layer (ADR-007).
 * The DB-layer (RLS) half is covered by rls.test.ts (Postgres-gated). Hermetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { resolveActor, login } from '@/auth/session';
import { seedTestUsers, TEST_USER_PASSWORD } from '@/db/seed-users';
import {
  requireCapability, requireOwnership, requireActor,
  ForbiddenError, UnauthenticatedError, authErrorStatus,
} from '@/auth/guard';

async function actorByEmail(store: MemoryStore, email: string) {
  const token = (await login(store, email, TEST_USER_PASSWORD))!.token;
  return (await resolveActor(store, token))!;
}

test('a plain user is denied admin-only capabilities; admin passes', async () => {
  const store = new MemoryStore();
  await seedTestUsers(store);
  const user = await actorByEmail(store, 'user@demo.test');
  const admin = await actorByEmail(store, 'admin@demo.test');

  // user MAY author own content (ADR-007 User bundle)…
  assert.doesNotThrow(() => requireCapability(user, 'author_content'));
  // …but is denied the admin-only platform/member-management capabilities.
  assert.throws(() => requireCapability(user, 'manage_org_members'), ForbiddenError);
  assert.throws(() => requireCapability(user, 'platform_admin'), ForbiddenError);

  // admin holds everything.
  assert.doesNotThrow(() => requireCapability(admin, 'manage_org_members'));
  assert.doesNotThrow(() => requireCapability(admin, 'platform_admin'));
});

test('operator holds the privacy step-up but not org/billing admin', async () => {
  const store = new MemoryStore();
  await seedTestUsers(store);
  const op = await actorByEmail(store, 'operator@demo.test');
  assert.doesNotThrow(() => requireCapability(op, 'assign_to_users'));
  assert.doesNotThrow(() => requireCapability(op, 'view_identified_results'));
  assert.throws(() => requireCapability(op, 'manage_billing'), ForbiddenError);
  assert.throws(() => requireCapability(op, 'platform_admin'), ForbiddenError);
});

test('ownership: a user may act on own rows, not others; admin may act on any', async () => {
  const store = new MemoryStore();
  await seedTestUsers(store);
  const user = await actorByEmail(store, 'user@demo.test');
  const other = await actorByEmail(store, 'operator@demo.test');
  const admin = await actorByEmail(store, 'admin@demo.test');

  assert.doesNotThrow(() => requireOwnership(user, user.userId));      // own row
  assert.throws(() => requireOwnership(user, other.userId), ForbiddenError); // someone else's
  assert.throws(() => requireOwnership(user, null), ForbiddenError);   // platform content
  assert.doesNotThrow(() => requireOwnership(admin, other.userId));    // admin overrides
  assert.doesNotThrow(() => requireOwnership(admin, null));            // admin can touch platform content
});

test('unauthenticated requests are rejected (401); guard errors map to HTTP status', async () => {
  assert.throws(() => requireActor(null), UnauthenticatedError);
  assert.equal(authErrorStatus(new UnauthenticatedError()), 401);
  assert.equal(authErrorStatus(new ForbiddenError()), 403);
  assert.equal(authErrorStatus(new Error('other')), null);
});

test('ownership-scoped reads: a user sees only their own scenarios in the in-memory model', async () => {
  // The MemoryStore mirrors ownership; RLS enforces the same at the DB (rls.test.ts).
  const store = new MemoryStore();
  await seedTestUsers(store);
  const a = await store.getUserByEmail('user@demo.test');
  const b = await store.getUserByEmail('operator@demo.test');

  await store.createScenario(
    { slug: 'a-private', name: 'A', description: null, aiInstructions: 'x', rubric: [], isPublic: false, voiceName: 'alloy', languageCode: 'en-US', tools: [], metadata: {} },
    { ownerUserId: a!.id },
  );
  await store.createScenario(
    { slug: 'b-private', name: 'B', description: null, aiInstructions: 'x', rubric: [], isPublic: false, voiceName: 'alloy', languageCode: 'en-US', tools: [], metadata: {} },
    { ownerUserId: b!.id },
  );

  const all = await store.listScenarios();
  const mineForA = all.filter((s) => s.ownerUserId === a!.id || s.isPublic);
  assert.equal(mineForA.some((s) => s.slug === 'a-private'), true);
  assert.equal(mineForA.some((s) => s.slug === 'b-private'), false);
});
