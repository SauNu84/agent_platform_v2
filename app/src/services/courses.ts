/**
 * Course service — use-case layer over the Store, mirroring scenarios.ts.
 * Includes course progress, which is a PROJECTION over completed sessions tagged
 * with this course (no separate progress table — derived per the ERD philosophy).
 */
import {
  courseFrontmatterSchema, normalizeCourseFrontmatter, type CompiledCourseRecord,
} from '@/domain/course';
import { compileCourseContent, CourseCompileError } from '@/compiler/course-compile';
import { sha256 } from '@/compiler/compile';
import type { CourseRecord, ScenarioRecord, Store } from '@/db/store';

export { CourseCompileError };

export async function listCourses(store: Store): Promise<CourseRecord[]> {
  return store.listCourses();
}

export async function getCourse(store: Store, slug: string): Promise<CourseRecord | null> {
  return store.getCourseBySlug(slug);
}

/** Resolve a course's scenarios in author order (the Play All sequence). */
export async function resolveCourseScenarios(store: Store, course: CourseRecord): Promise<ScenarioRecord[]> {
  const out: ScenarioRecord[] = [];
  for (const id of course.scenarioIds) {
    const s = await store.getScenarioById(id);
    if (s) out.push(s);
  }
  return out;
}

export async function createCourseFromMarkdown(
  store: Store,
  raw: string,
  opts: { repoPath?: string; revision?: string | null } = {},
): Promise<{ course: CourseRecord; created: boolean }> {
  const { record, contentHash } = compileCourseContent(raw);
  const res = await store.upsertCourseFromCompile(record, {
    repoPath: opts.repoPath ?? `inline:${record.slug}.course.md`,
    contentHash,
    revision: opts.revision ?? null,
  });
  return { course: res.course, created: res.created };
}

export async function createCourseFromJson(store: Store, body: unknown): Promise<CourseRecord> {
  const parsed = courseFrontmatterSchema.safeParse(body);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new CourseCompileError(`invalid course: ${lines}`, parsed.error.issues);
  }
  const record: CompiledCourseRecord = normalizeCourseFrontmatter(parsed.data);
  const existing = await store.getCourseBySlug(record.slug);
  if (existing) throw new CourseCompileError(`course with slug "${record.slug}" already exists`);
  const res = await store.upsertCourseFromCompile(record, {
    repoPath: `api:${record.slug}`,
    contentHash: sha256(JSON.stringify(body)),
    revision: null,
  });
  return res.course;
}

export async function deleteCourse(store: Store, slug: string): Promise<boolean> {
  return store.deleteCourse(slug);
}

// ── Progress (projection over completed in-course sessions) ──────────────────
export interface CourseProgressItem {
  scenarioId: string;
  slug: string;
  name: string;
  completed: boolean;
  sessions: number;
}

export interface CourseProgress {
  total: number;
  completed: number;
  fraction: number;        // 0..1
  items: CourseProgressItem[];
}

/**
 * A course item counts as completed once the user has at least one COMPLETED
 * session for that scenario started inside this course. `userId` null = no
 * progress (anonymous), so a fresh viewer sees an empty progress bar.
 */
export async function getCourseProgress(
  store: Store,
  course: CourseRecord,
  userId: string | null,
): Promise<CourseProgress> {
  const scenarios = await resolveCourseScenarios(store, course);
  const sessions = userId
    ? (await store.listSessionsByCourse(course.id)).filter((s) => s.userId === userId)
    : [];
  const byScenario = new Map<string, number>();
  for (const s of sessions) {
    if (s.status === 'completed') byScenario.set(s.scenarioId, (byScenario.get(s.scenarioId) ?? 0) + 1);
  }
  const items: CourseProgressItem[] = scenarios.map((sc) => ({
    scenarioId: sc.id,
    slug: sc.slug,
    name: sc.name,
    completed: (byScenario.get(sc.id) ?? 0) > 0,
    sessions: byScenario.get(sc.id) ?? 0,
  }));
  const completed = items.filter((i) => i.completed).length;
  const total = items.length;
  return { total, completed, fraction: total ? completed / total : 0, items };
}
