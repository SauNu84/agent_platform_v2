/**
 * Seed scenarios from the content-as-code source files (content/scenarios/*.md).
 *
 * - `loadSeedRecords()` is sync (read + compile) — used to populate the in-memory
 *   dev store at boot so the Library has data with zero infra.
 * - `seedScenarios(store)` is the async CLI path that upserts into any store
 *   (Postgres in prod). Run with: DATABASE_URL=... npm run seed
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compileScenarioContent, type CompileResult } from '@/compiler/compile';
import type { Store } from './store';

export function contentDir(): string {
  return join(process.cwd(), 'content', 'scenarios');
}

export interface SeedRecord {
  record: CompileResult['record'];
  repoPath: string;
  contentHash: string;
}

export function loadSeedRecords(): SeedRecord[] {
  const dir = contentDir();
  if (!existsSync(dir)) return [];
  const out: SeedRecord[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const raw = readFileSync(join(dir, file), 'utf8');
    try {
      const { record, contentHash } = compileScenarioContent(raw);
      out.push({ record, repoPath: `content/scenarios/${file}`, contentHash });
    } catch (e) {
      console.error(`[seed] skipping ${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function seedScenarios(store: Store): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const { record, repoPath, contentHash } of loadSeedRecords()) {
    const res = await store.upsertScenarioFromCompile(record, { repoPath, contentHash, revision: null });
    if (res.created) created++;
    else updated++;
  }
  return { created, updated };
}
