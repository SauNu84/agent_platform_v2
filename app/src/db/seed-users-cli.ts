/**
 * Seed only the test users (one per role). Usage:
 *   DATABASE_URL=postgres://... npm run seed:users
 */
import { getStore } from './index';
import { seedTestUsers, TEST_USERS, TEST_USER_PASSWORD } from './seed-users';

async function main(): Promise<void> {
  const res = await seedTestUsers(getStore());
  console.log(`test users: ${res.created} created, ${res.existing} already existed.`);
  for (const u of TEST_USERS) {
    console.log(`  ${u.role.padEnd(9)} ${u.email}  (password: ${TEST_USER_PASSWORD})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
