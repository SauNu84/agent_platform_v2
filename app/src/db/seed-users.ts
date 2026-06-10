/**
 * Seed the documented test users — one per role (SAU-229 board ask).
 *
 * Idempotent: skips users that already exist (but re-asserts their role). The
 * credentials are intentionally well-known for QA and are documented in the app
 * README. NEVER seed these in production — guarded by the CLI.
 */
import type { Store } from './store';
import { hashPassword } from '@/auth/password';

/** Shared dev/QA password for every seeded test user. */
export const TEST_USER_PASSWORD = 'password123';

export const TEST_USERS: ReadonlyArray<{ email: string; displayName: string; role: string }> = [
  { email: 'user@demo.test', displayName: 'Demo User', role: 'user' },
  { email: 'admin@demo.test', displayName: 'Demo Admin', role: 'admin' },
  { email: 'operator@demo.test', displayName: 'Demo Operator', role: 'operator' },
];

export async function seedTestUsers(store: Store): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  for (const u of TEST_USERS) {
    const found = await store.getUserByEmail(u.email);
    if (found) {
      await store.setUserRole(found.id, u.role); // keep role in sync on re-seed
      existing++;
      continue;
    }
    const passwordHash = await hashPassword(TEST_USER_PASSWORD);
    const rec = await store.createUser({ email: u.email, passwordHash, displayName: u.displayName });
    await store.setUserRole(rec.id, u.role);
    created++;
  }
  return { created, existing };
}
