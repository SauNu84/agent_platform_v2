/**
 * Current-user resolution (interim, pre-auth).
 *
 * Slice 1 left `session.user_id` a nullable uuid with no user table / auth yet.
 * Slice 2 needs a *subject* so History and the credit meter are per-user. Until
 * the identity model lands we resolve a user from the `x-user-id` header (so the
 * API can be exercised as different users) and fall back to a stable demo uuid so
 * the UI works out of the box. This is the single seam to replace with real auth.
 */
import type { NextRequest } from 'next/server';

/** Stable demo subject so History/metering have data before auth lands. */
export const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the acting user id from a request header, else the demo subject. */
export function currentUserId(req?: NextRequest): string {
  const hdr = req?.headers.get('x-user-id');
  if (hdr && UUID_RE.test(hdr)) return hdr;
  return DEMO_USER_ID;
}
