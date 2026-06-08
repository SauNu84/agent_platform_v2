/**
 * Seed coaches + courses from content-as-code (content/coaches/*.md,
 * content/courses/*.md), mirroring seed.ts for scenarios.
 *
 * - `loadCoachSeedRecords()` / `loadCourseSeedRecords()` are sync (read + compile),
 *   used to populate the in-memory dev store at boot.
 * - `seedCoaches(store)` / `seedCourses(store)` are the async CLI path that upserts
 *   into any store (Postgres in prod). Order matters: scenarios → coaches → courses.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compileCoachContent } from '@/compiler/coach-compile';
import { compileCourseContent } from '@/compiler/course-compile';
import type { CompiledCoachRecord } from '@/domain/coach';
import type { CompiledCourseRecord } from '@/domain/course';
import type { Store } from './store';

function dir(kind: 'coaches' | 'courses'): string {
  return join(process.cwd(), 'content', kind);
}

export interface CoachSeed { record: CompiledCoachRecord; repoPath: string; contentHash: string; }
export interface CourseSeed { record: CompiledCourseRecord; repoPath: string; contentHash: string; }

export function loadCoachSeedRecords(): CoachSeed[] {
  const d = dir('coaches');
  if (!existsSync(d)) return [];
  const out: CoachSeed[] = [];
  for (const file of readdirSync(d).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const { record, contentHash } = compileCoachContent(readFileSync(join(d, file), 'utf8'));
      out.push({ record, repoPath: `content/coaches/${file}`, contentHash });
    } catch (e) {
      console.error(`[seed] skipping coach ${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function loadCourseSeedRecords(): CourseSeed[] {
  const d = dir('courses');
  if (!existsSync(d)) return [];
  const out: CourseSeed[] = [];
  for (const file of readdirSync(d).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const { record, contentHash } = compileCourseContent(readFileSync(join(d, file), 'utf8'));
      out.push({ record, repoPath: `content/courses/${file}`, contentHash });
    } catch (e) {
      console.error(`[seed] skipping course ${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function seedCoaches(store: Store): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const { record, repoPath, contentHash } of loadCoachSeedRecords()) {
    const res = await store.upsertCoachFromCompile(record, { repoPath, contentHash, revision: null });
    if (res.created) created++;
    else updated++;
  }
  return { created, updated };
}

export async function seedCourses(store: Store): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const { record, repoPath, contentHash } of loadCourseSeedRecords()) {
    const res = await store.upsertCourseFromCompile(record, { repoPath, contentHash, revision: null });
    if (res.created) created++;
    else updated++;
  }
  return { created, updated };
}
