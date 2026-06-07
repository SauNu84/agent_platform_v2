/**
 * Seed CLI — compile content/scenarios/*.md into the configured store.
 * Usage: DATABASE_URL=postgres://... npm run seed
 */
import { getStore } from './index';
import { seedScenarios } from './seed';

async function main(): Promise<void> {
  const store = getStore();
  const { created, updated } = await seedScenarios(store);
  console.log(`seed complete: ${created} created, ${updated} updated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
