/**
 * Course content-as-code compiler (ADR-002), mirroring the Scenario compiler.
 *
 *   .md  →  parse frontmatter  →  validate  →  normalize to CompiledCourseRecord.
 *
 * The compiled record carries scenario *refs* (slugs) in author order and an
 * optional coach ref; the store resolves them to UUIDs + `course_scenario`
 * positions at upsert time.
 */
import matter from 'gray-matter';
import {
  courseFrontmatterSchema, normalizeCourseFrontmatter,
  type CompiledCourseRecord, type CourseFrontmatter,
} from '@/domain/course';
import { sha256 } from './compile';

export class CourseCompileError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = 'CourseCompileError';
  }
}

export interface CourseCompileResult {
  record: CompiledCourseRecord;
  frontmatter: CourseFrontmatter;
  contentHash: string;
}

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
    // e.g. duplicate ordered members — surface as a compile error, not a raw throw.
    throw new CourseCompileError((e as Error).message);
  }
  return { record, frontmatter: result.data, contentHash: sha256(raw) };
}

/**
 * Reference check (Slice-4 safety gate, SAU-210 / ADR-006): every scenario the
 * course lists must resolve to a known slug (e.g. the scenarios generated
 * alongside an AI-authored course, or those already in the store). Throws an
 * actionable `CourseCompileError` naming the missing refs — this is the gate
 * that prevents publishing a course with dangling scenario references.
 */
export function validateCourseReferences(record: CompiledCourseRecord, knownSlugs: Iterable<string>): void {
  const known = new Set(knownSlugs);
  const missing = record.scenarioRefs.filter((slug) => !known.has(slug));
  if (missing.length) {
    throw new CourseCompileError(
      `course "${record.slug}" references scenario(s) that do not exist: ${missing.join(', ')}`,
    );
  }
}

/** Render a compiled course back to MD source (export / round-trip). */
export function renderCourseToMarkdown(record: CompiledCourseRecord): string {
  const data: Record<string, unknown> = {
    id: record.slug,
    name: record.name,
    scenarios: record.scenarioRefs,
    visibility: record.isPublic ? 'public' : 'private',
    metadata: record.metadata,
  };
  if (record.description) data.description = record.description;
  if (record.coachRef) data.coach_ref = record.coachRef;
  return matter.stringify('', data);
}
