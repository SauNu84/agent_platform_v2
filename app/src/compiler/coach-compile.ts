/**
 * Coach content-as-code compiler (ADR-002), mirroring the Scenario compiler.
 *
 *   .md  →  parse frontmatter  →  validate  →  normalize to CompiledCoachRecord.
 *
 * The compiled record carries the `scenario_ref` (slug); the store resolves it to
 * the scenario UUID at upsert time. A malformed file fails validation and NEVER
 * reaches the DB. Round-trip stable: compile(render(compile(x))) == compile(x).
 */
import matter from 'gray-matter';
import {
  coachFrontmatterSchema, normalizeCoachFrontmatter,
  type CompiledCoachRecord, type CoachFrontmatter,
} from '@/domain/coach';
import { sha256 } from './compile';

export class CoachCompileError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = 'CoachCompileError';
  }
}

export interface CoachCompileResult {
  record: CompiledCoachRecord;
  frontmatter: CoachFrontmatter;
  contentHash: string;
}

export function compileCoachContent(raw: string): CoachCompileResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e) {
    throw new CoachCompileError(`frontmatter could not be parsed: ${(e as Error).message}`);
  }
  const result = coachFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new CoachCompileError(`coach frontmatter failed validation:\n${lines}`, result.error.issues);
  }
  const record = normalizeCoachFrontmatter(result.data);
  return { record, frontmatter: result.data, contentHash: sha256(raw) };
}

/** Render a compiled coach back to MD source (export / round-trip). */
export function renderCoachToMarkdown(record: CompiledCoachRecord): string {
  const data: Record<string, unknown> = {
    id: record.slug,
    name: record.name,
    scenario_ref: record.scenarioRef,
    memory_scope: record.memoryScope,
    retention: record.retention,
    schedule: record.schedule,
  };
  return matter.stringify('', data);
}
