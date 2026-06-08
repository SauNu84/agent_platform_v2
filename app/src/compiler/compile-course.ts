/**
 * Course MD compiler (ADR-002) — the same content-as-code safety gate the
 * Scenario compiler provides, applied to Courses.
 *
 * A course compiles only if (a) its frontmatter validates against the schema and
 * (b) every scenario it references resolves to a real, compilable scenario. The
 * second check is what makes a generated course "working": a course that points
 * at a scenario that doesn't exist is rejected with an actionable error rather
 * than persisted as a dangling reference.
 */
import matter from 'gray-matter';
import { sha256, ScenarioCompileError } from './compile';
import {
  courseFrontmatterSchema, normalizeCourseFrontmatter, type CompiledCourseRecord,
} from '@/domain/course';

export class CourseCompileError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = 'CourseCompileError';
  }
}

export interface CourseCompileResult {
  record: CompiledCourseRecord;
  body: string;
  contentHash: string;
}

/**
 * Pure compile: raw course MD string → validated, normalized canonical record.
 * No I/O — reference resolution (do the member scenarios exist?) is a separate
 * step (`validateCourseReferences`) so this stays unit-testable in isolation.
 */
export function compileCourseContent(raw: string): CourseCompileResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e) {
    throw new CourseCompileError(`frontmatter could not be parsed: ${(e as Error).message}`);
  }
  const result = courseFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new CourseCompileError(`course frontmatter failed validation:\n${lines}`, result.error.issues);
  }
  let record: CompiledCourseRecord;
  try {
    record = normalizeCourseFrontmatter(result.data);
  } catch (e) {
    throw new CourseCompileError((e as Error).message);
  }
  return { record, body: parsed.content, contentHash: sha256(raw) };
}

/**
 * Reference check: every scenario the course lists must be in `knownSlugs`
 * (e.g. the slugs of the scenarios generated alongside the course, or the slugs
 * already in the store). Throws an actionable `CourseCompileError` naming the
 * missing references — this is the gate that prevents publishing a broken course.
 */
export function validateCourseReferences(record: CompiledCourseRecord, knownSlugs: Iterable<string>): void {
  const known = new Set(knownSlugs);
  const missing = record.scenarioSlugs.filter((slug) => !known.has(slug));
  if (missing.length) {
    throw new CourseCompileError(
      `course "${record.slug}" references scenario(s) that do not exist: ${missing.join(', ')}`,
    );
  }
}

// Re-export so authoring consumers have one import surface for the gate errors.
export { ScenarioCompileError };
