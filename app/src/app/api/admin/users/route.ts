/**
 * GET /api/admin/users — list users + their roles. ADMIN ONLY.
 *
 * This is the canonical admin-gated action for the RBAC acceptance check: a
 * plain `user` is denied (403, no manage_org_members capability) at the API
 * layer; an `admin` passes. Managing members is a platform-admin concern
 * (ADR-007); the B2B Operator role would also gain this via manage_org_members.
 */
import { NextResponse } from 'next/server';
import { getStore } from '@/db';
import { actorWithCapability } from '@/auth/api-guard';

export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await actorWithCapability('manage_org_members');
  if ('response' in gate) return gate.response;

  const store = getStore();
  const users = await store.listUsers();
  const withRoles = await Promise.all(
    users.map(async (u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: (await store.getUserRole(u.id)) ?? 'user',
      createdAt: u.createdAt,
    })),
  );
  return NextResponse.json({ users: withRoles });
}
