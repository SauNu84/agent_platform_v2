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
  const record = normalizeCourseFrontmatter(result.data);
  return { record, frontmatter: result.data, contentHash: sha256(raw) };
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
