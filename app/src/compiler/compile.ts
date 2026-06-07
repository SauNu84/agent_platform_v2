/**
 * MD content-as-code compiler (ADR-002).
 *
 * Pipeline:  .md file  →  parse frontmatter + body  →  validate against schema
 *            →  normalize to canonical record  →  upsert DB row + content_source.
 *
 * The MD file is the source of truth; the DB row is a projection tagged with the
 * source `content_hash` (sha256 of the raw file) and git `revision` for drift
 * detection. A malformed file fails validation and NEVER reaches the DB.
 */
import matter from 'gray-matter';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  scenarioFrontmatterSchema, normalizeFrontmatter, type CompiledScenarioRecord, type ScenarioFrontmatter,
} from '@/domain/scenario';
import type { ContentSourceRecord, ScenarioRecord, Store } from '@/db/store';

export class ScenarioCompileError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = 'ScenarioCompileError';
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface CompileResult {
  record: CompiledScenarioRecord;
  frontmatter: ScenarioFrontmatter;
  body: string;
  contentHash: string;
}

/**
 * Pure compile: raw MD string → validated, normalized canonical record.
 * No I/O, no DB — this is the unit covered by the round-trip test.
 */
export function compileScenarioContent(raw: string): CompileResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e) {
    throw new ScenarioCompileError(`frontmatter could not be parsed: ${(e as Error).message}`);
  }
  const result = scenarioFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ScenarioCompileError(`scenario frontmatter failed validation:\n${lines}`, result.error.issues);
  }
  let record: CompiledScenarioRecord;
  try {
    record = normalizeFrontmatter(result.data, parsed.content);
  } catch (e) {
    // e.g. an unknown named tool that isn't in the registry
    throw new ScenarioCompileError((e as Error).message);
  }
  return { record, frontmatter: result.data, body: parsed.content, contentHash: sha256(raw) };
}

/** Best-effort git sha for the working tree (null outside a repo). */
function gitRevision(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Compile a single .md file from disk and upsert it into the store (transactional:
 * scenario row + content_source together). Returns the canonical record + source.
 */
export async function compileScenarioFile(
  filePath: string,
  store: Store,
  opts: { repoPath?: string; revision?: string | null } = {},
): Promise<{ scenario: ScenarioRecord; source: ContentSourceRecord; created: boolean }> {
  const raw = readFileSync(filePath, 'utf8');
  const { record, contentHash } = compileScenarioContent(raw);
  const repoPath = opts.repoPath ?? filePath;
  const revision = opts.revision !== undefined ? opts.revision : gitRevision(process.cwd());
  return store.upsertScenarioFromCompile(record, { repoPath, contentHash, revision });
}

/**
 * Render a canonical record back to MD source (for round-trip / export). The
 * persona is the frontmatter `persona`; any appended "## Reference briefing"
 * section is moved back to the body, so render(compile(x)) is stable.
 */
export function renderScenarioToMarkdown(record: CompiledScenarioRecord): string {
  const marker = '\n\n## Reference briefing\n';
  const idx = record.aiInstructions.indexOf(marker);
  const persona = idx >= 0 ? record.aiInstructions.slice(0, idx) : record.aiInstructions;
  const body = idx >= 0 ? record.aiInstructions.slice(idx + marker.length) : '';
  const data: Record<string, unknown> = {
    id: record.slug,
    name: record.name,
    persona,
    rubric: record.rubric,
    voice: { name: record.voiceName, language: record.languageCode },
    tools: record.tools.map((t) => t.name),
    visibility: record.isPublic ? 'public' : 'private',
    metadata: record.metadata,
  };
  if (record.description) data.description = record.description;
  return matter.stringify(body, data);
}

/**
 * Has the compiled row drifted from the current file? Compares stored
 * content_hash with the freshly computed hash (ADR-002 drift control).
 */
export async function isStale(filePath: string, store: Store, scenarioId: string): Promise<boolean> {
  const raw = readFileSync(filePath, 'utf8');
  const source = await store.getContentSource('scenario', scenarioId);
  if (!source) return true;
  return source.contentHash !== sha256(raw);
}
