/**
 * Coach service — use-case layer over the Store, mirroring scenarios.ts.
 * Two creation paths (Markdown content-as-code + JSON CRUD) validate the SAME
 * frontmatter schema, so the API can't persist a coach the compiler would reject.
 */
import {
  coachFrontmatterSchema, normalizeCoachFrontmatter, type CompiledCoachRecord,
} from '@/domain/coach';
import { compileCoachContent, CoachCompileError } from '@/compiler/coach-compile';
import { sha256 } from '@/compiler/compile';
import type { CoachRecord, OwnerOpts, ScenarioRecord, Store } from '@/db/store';

export { CoachCompileError };

export async function listCoaches(store: Store): Promise<CoachRecord[]> {
  return store.listCoaches();
}

export async function getCoach(store: Store, slug: string): Promise<CoachRecord | null> {
  return store.getCoachBySlug(slug);
}

/** Resolve the Scenario a coach composes (ADR-001). MVP coaches always ref one. */
export async function resolveCoachScenario(store: Store, coach: CoachRecord): Promise<ScenarioRecord | null> {
  return coach.scenarioId ? store.getScenarioById(coach.scenarioId) : null;
}

export async function createCoachFromMarkdown(
  store: Store,
  raw: string,
  opts: { repoPath?: string; revision?: string | null } = {},
  owner?: OwnerOpts,
): Promise<{ coach: CoachRecord; created: boolean }> {
  const { record, contentHash } = compileCoachContent(raw);
  const res = await store.upsertCoachFromCompile(record, {
    repoPath: opts.repoPath ?? `inline:${record.slug}.coach.md`,
    contentHash,
    revision: opts.revision ?? null,
  }, owner);
  return { coach: res.coach, created: res.created };
}

export async function createCoachFromJson(store: Store, body: unknown, owner?: OwnerOpts): Promise<CoachRecord> {
  const parsed = coachFrontmatterSchema.safeParse(body);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new CoachCompileError(`invalid coach: ${lines}`, parsed.error.issues);
  }
  const record: CompiledCoachRecord = normalizeCoachFrontmatter(parsed.data);
  const existing = await store.getCoachBySlug(record.slug);
  if (existing) throw new CoachCompileError(`coach with slug "${record.slug}" already exists`);
  const res = await store.upsertCoachFromCompile(record, {
    repoPath: `api:${record.slug}`,
    contentHash: sha256(JSON.stringify(body)),
    revision: null,
  }, owner);
  return res.coach;
}

export async function deleteCoach(store: Store, slug: string): Promise<boolean> {
  return store.deleteCoach(slug);
}
