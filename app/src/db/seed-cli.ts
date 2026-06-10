/**
 * Seed CLI — compile content/{scenarios,coaches,courses}/*.md into the configured
 * store. Order matters: scenarios → coaches → courses (refs resolve forward).
 * Usage: DATABASE_URL=postgres://... npm run seed
 */
import { getStore } from './index';
import { seedScenarios } from './seed';
import { seedCoaches, seedCourses } from './seed-compositions';
import { seedTestUsers } from './seed-users';
import { runWithActor } from '@/auth/actor';

async function main(): Promise<void> {
  const store = getStore();
  // Platform/seeded content has no owner. Under FORCE RLS (migration 0005), the
  // write policy requires owner=app.user_id OR admin — so run the whole seed as
  // an admin actor (app.is_admin = 'on') to insert null-owner platform content.
  await runWithActor({ userId: '00000000-0000-0000-0000-000000000000', isAdmin: true }, async () => {
    const u = await seedTestUsers(store);
    const s = await seedScenarios(store);
    const co = await seedCoaches(store);
    const cu = await seedCourses(store);
    console.log(
      `seed complete: users ${u.created}+${u.existing}, scenarios ${s.created}+${s.updated}, ` +
      `coaches ${co.created}+${co.updated}, courses ${cu.created}+${cu.updated}.`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
