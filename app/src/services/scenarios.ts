/**
 * Scenario service — the use-case layer over the Store. API routes stay thin and
 * this is what tests drive. Two creation paths, one canonical projection:
 *   - fromMarkdown: the content-as-code path (ADR-002) — MD is the source of truth.
 *   - fromJson:     a convenience CRUD path that validates the SAME frontmatter
 *                   schema, so the API can't write a row the compiler couldn't.
 */
import {
  scenarioFrontmatterSchema, normalizeFrontmatter, type CompiledScenarioRecord,
} from '@/domain/scenario';
import { compileScenarioContent, sha256, ScenarioCompileError } from '@/compiler/compile';
import type { ScenarioFilter, ScenarioRecord, Store } from '@/db/store';

export { ScenarioCompileError };

export async function listScenarios(store: Store, filter?: ScenarioFilter): Promise<ScenarioRecord[]> {
  return store.listScenarios(filter);
}

export async function getScenario(store: Store, slug: string): Promise<ScenarioRecord | null> {
  return store.getScenarioBySlug(slug);
}

/** Content-as-code path: compile MD and upsert the row + content_source. */
export async function createScenarioFromMarkdown(
  store: Store,
  raw: string,
  opts: { repoPath?: string; revision?: string | null } = {},
): Promise<{ scenario: ScenarioRecord; created: boolean }> {
  const { record, contentHash } = compileScenarioContent(raw);
  const res = await store.upsertScenarioFromCompile(record, {
    repoPath: opts.repoPath ?? `inline:${record.slug}.md`,
    contentHash,
    revision: opts.revision ?? null,
  });
  return { scenario: res.scenario, created: res.created };
}

/** JSON CRUD create — validated against the same schema as the compiler. */
export async function createScenarioFromJson(store: Store, body: unknown): Promise<ScenarioRecord> {
  const parsed = scenarioFrontmatterSchema.safeParse(body);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ScenarioCompileError(`invalid scenario: ${lines}`, parsed.error.issues);
  }
  const record: CompiledScenarioRecord = normalizeFrontmatter(parsed.data, '');
  const existing = await store.getScenarioBySlug(record.slug);
  if (existing) throw new ScenarioCompileError(`scenario with slug "${record.slug}" already exists`);
  // Record a content_source so drift detection still works for API-created rows.
  const res = await store.upsertScenarioFromCompile(record, {
    repoPath: `api:${record.slug}`,
    contentHash: sha256(JSON.stringify(body)),
    revision: null,
  });
  return res.scenario;
}

export async function updateScenario(store: Store, slug: string, body: unknown): Promise<ScenarioRecord | null> {
  const existing = await store.getScenarioBySlug(slug);
  if (!existing) return null;
  // NB: per ADR-002 the DB is downstream of MD. Direct edits to compiled fields are
  // a convenience for API consumers and will be overwritten on the next compile of
  // the source file. Allowed as a known constraint (ADR-002 §Consequences).
  return store.updateScenario(slug, toPatch(body));
}

export async function deleteScenario(store: Store, slug: string): Promise<boolean> {
  return store.deleteScenario(slug);
}

/** Map a partial JSON edit body to a CompiledScenarioRecord patch. */
function toPatch(body: unknown): Partial<CompiledScenarioRecord> {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<CompiledScenarioRecord> = {};
  if (typeof b.name === 'string') patch.name = b.name;
  if (typeof b.description === 'string') patch.description = b.description;
  if (typeof b.persona === 'string') patch.aiInstructions = b.persona;
  if (typeof b.ai_instructions === 'string') patch.aiInstructions = b.ai_instructions as string;
  if (Array.isArray(b.rubric)) patch.rubric = b.rubric as CompiledScenarioRecord['rubric'];
  if (b.visibility === 'public' || b.visibility === 'private') patch.isPublic = b.visibility === 'public';
  if (typeof b.isPublic === 'boolean') patch.isPublic = b.isPublic;
  if (b.voice && typeof b.voice === 'object') {
    const v = b.voice as Record<string, unknown>;
    if (typeof v.name === 'string') patch.voiceName = v.name;
    if (typeof v.language === 'string') patch.languageCode = v.language;
  }
  if (b.metadata && typeof b.metadata === 'object') patch.metadata = b.metadata as Record<string, unknown>;
  return patch;
}
