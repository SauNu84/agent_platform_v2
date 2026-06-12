/**
 * Route-handler authorization helper (server-only — imports next/server).
 *
 * Resolves the request actor and checks a capability in one call, returning
 * either the actor or a ready-to-return 401/403 NextResponse. Keeps the pure
 * guard logic (guard.ts) free of framework imports so it stays unit-testable.
 */
import { NextResponse } from 'next/server';
import { getActor } from '@/services/current-user';
import type { Capability } from './rbac';
import type { Actor } from './session';

type Gate = { actor: Actor } | { response: NextResponse };

/** Require an authenticated actor (no capability check). */
export async function actorOr401(): Promise<Gate> {
  const actor = await getActor();
  if (!actor) return { response: NextResponse.json({ error: 'authentication required' }, { status: 401 }) };
  return { actor };
}

/** Require an authenticated actor with the admin role (403 otherwise). */
export async function adminOr403(): Promise<Gate> {
  const gate = await actorOr401();
  if ('response' in gate) return gate;
  if (!gate.actor.isAdmin) {
    return { response: NextResponse.json({ error: 'admin role required' }, { status: 403 }) };
  }
  return gate;
}

/** Require an authenticated actor holding `cap` (admin holds all). */
export async function actorWithCapability(cap: Capability): Promise<Gate> {
  const gate = await actorOr401();
  if ('response' in gate) return gate;
  if (!gate.actor.isAdmin && !gate.actor.capabilities.includes(cap)) {
    return { response: NextResponse.json({ error: `missing capability: ${cap}` }, { status: 403 }) };
  }
  return gate;
}
