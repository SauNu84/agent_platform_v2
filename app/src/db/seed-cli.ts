/**
 * Seed CLI — compile content/{scenarios,coaches,courses}/*.md into the configured
 * store. Order matters: scenarios → coaches → courses (refs resolve forward).
 * Usage: DATABASE_URL=postgres://... npm run seed
 */
import { getStore } from './index';
import { seedScenarios } from './seed';
import { seedCoaches, seedCourses } from './seed-compositions';

async function main(): Promise<void> {
  const store = getStore();
  const s = await seedScenarios(store);
  const co = await seedCoaches(store);
  const cu = await seedCourses(store);
  console.log(
    `seed complete: scenarios ${s.created}+${s.updated}, coaches ${co.created}+${co.updated}, courses ${cu.created}+${cu.updated} (created+updated).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
