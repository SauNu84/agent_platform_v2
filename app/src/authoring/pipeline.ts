/**
 * AI authoring pipeline (Slice 4, SAU-203) — generate → validate → repair → review.
 *
 * The contract from the brief: an LLM emits Scenario/Course **Markdown**; it never
 * writes the DB. This module is where that guarantee lives:
 *
 *   1. GENERATE  — ask the `Author` (template default / Claude live) for MD.
 *   2. VALIDATE  — run the Slice-1 compiler. This is the safety gate: malformed
 *                  generations are rejected with actionable, line-level errors.
 *   3. REPAIR    — feed those errors back to the author and retry (bounded).
 *   4. DRAFT     — return a NON-published draft. Nothing touches the store yet.
 *   5. REVIEW    — `publish*` is the human/coach gate: it refuses unless the draft
 *                  passed validation AND an explicit approver is named, and it
 *                  re-validates the exact bytes before persisting.
 *
 * So "nothing publishes without passing validation" is enforced twice — at draft
 * time (the compiler) and again at publish time (re-compile of the approved MD).
 */
import { compileScenarioContent, sha256, ScenarioCompileError } from '@/compiler/compile';
import {
  compileCourseContent, validateCourseReferences, CourseCompileError,
} from '@/compiler/course-compile';
import type { CompiledScenarioRecord, ScenarioRecord } from '@/domain/scenario';
import type { CompiledCourseRecord } from '@/domain/course';
import type { Store } from '@/db/store';
import {
  Author, AuthoringBrief, AuthoringEffort, getAuthor, PriorAttempt,
  ScenarioEditFields, scenarioFieldsToMd,
} from './author';

export class AuthoringError extends Error {}

export interface PipelineOptions {
  author?: Author;
  /** Total generation attempts (1 = no repair). Default 2. */
  maxAttempts?: number;
  /** Model-effort for the authoring call (AI Studio Flash/Deep, SAU-244). */
  effort?: AuthoringEffort;
}

// ── Draft shapes (the validated-but-unpublished artifact) ─────────────────────

export interface ScenarioDraft {
  kind: 'scenario';
  ok: boolean;
  md: string;
  /** Present iff ok — the compiled, schema-valid projection (NOT persisted). */
  record?: CompiledScenarioRecord;
  slug?: string;
  /** Present iff !ok — actionable validation errors. */
  errors?: string;
  attempts: number;
  author: string;
}

export interface CourseMemberDraft {
  ok: boolean;
  md: string;
  record?: CompiledScenarioRecord;
  slug?: string;
  errors?: string;
}

export interface CourseDraft {
  kind: 'course';
  ok: boolean;
  courseMd: string;
  course?: CompiledCourseRecord;
  scenarios: CourseMemberDraft[];
  errors?: string;
  attempts: number;
  author: string;
}

// ── 1–4: generate + validate (+ repair), return a draft ───────────────────────

/** Generate a single scenario and validate it against the Slice-1 compiler. */
export async function generateScenarioDraft(
  brief: AuthoringBrief,
  opts: PipelineOptions = {},
): Promise<ScenarioDraft> {
  const author = opts.author ?? getAuthor();
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  let prior: PriorAttempt | undefined;
  let lastMd = '';
  let lastErrors = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastMd = await author.generateScenario(brief, { prior, effort: opts.effort });
    try {
      const { record } = compileScenarioContent(lastMd);
      return { kind: 'scenario', ok: true, md: lastMd, record, slug: record.slug, attempts: attempt, author: author.name };
    } catch (e) {
      lastErrors = (e as Error).message;
      prior = { md: lastMd, errors: lastErrors };
    }
  }
  return { kind: 'scenario', ok: false, md: lastMd, errors: lastErrors, attempts: maxAttempts, author: author.name };
}

/**
 * Generate a course (manifest + member scenarios) and validate the whole thing:
 * every member scenario must compile AND the course manifest must compile AND
 * every reference must resolve. Any failure → repair the entire course (bounded).
 */
export async function generateCourseDraft(
  brief: AuthoringBrief,
  opts: PipelineOptions = {},
): Promise<CourseDraft> {
  const author = opts.author ?? getAuthor();
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  let prior: PriorAttempt | undefined;
  let last: CourseDraft = { kind: 'course', ok: false, courseMd: '', scenarios: [], attempts: 0, author: author.name };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { courseMd, scenarioMds } = await author.generateCourse(brief, { prior });
    const errors: string[] = [];

    // Validate each member scenario (the safety gate, per scenario).
    const members: CourseMemberDraft[] = scenarioMds.map((md) => {
      try {
        const { record } = compileScenarioContent(md);
        return { ok: true, md, record, slug: record.slug };
      } catch (e) {
        const msg = (e as Error).message;
        errors.push(`member scenario: ${msg}`);
        return { ok: false, md, errors: msg };
      }
    });

    // Validate the course manifest + that every reference resolves to a member.
    let course: CompiledCourseRecord | undefined;
    try {
      course = compileCourseContent(courseMd).record;
      const knownSlugs = members.filter((m) => m.ok && m.slug).map((m) => m.slug!) as string[];
      validateCourseReferences(course, knownSlugs);
    } catch (e) {
      errors.push((e as Error).message);
      course = undefined;
    }

    const ok = errors.length === 0;
    last = {
      kind: 'course', ok, courseMd, course, scenarios: members,
      errors: ok ? undefined : errors.join('\n'), attempts: attempt, author: author.name,
    };
    if (ok) return last;
    prior = { md: courseMd + '\n\n' + scenarioMds.join('\n\n'), errors: errors.join('\n') };
  }
  return last;
}

// ── Edit (AI Studio, SAU-244): patch a draft from a NL instruction ────────────

export interface ScenarioEditDraft {
  kind: 'edit';
  ok: boolean;
  /** The patched field set the form re-renders from (always returned). */
  fields: ScenarioEditFields;
  /** One-line "what changed" summary for the copilot turn. */
  summary: string;
  /** Present iff !ok — actionable validation errors (the patch didn't compile). */
  errors?: string;
  author: string;
}

/**
 * Apply a natural-language instruction to the current draft field set and
 * VALIDATE the result against the Slice-1 compiler (the same safety gate as
 * generation). It NEVER writes the DB — the copilot proposes a patch the author
 * reviews in the form. A patch that fails to compile comes back `ok: false` with
 * actionable errors, but the proposed `fields` are still returned so the author
 * can see and hand-fix them.
 */
export async function editScenarioDraft(
  current: ScenarioEditFields,
  instruction: string,
  opts: PipelineOptions = {},
): Promise<ScenarioEditDraft> {
  const author = opts.author ?? getAuthor();
  const { fields, summary } = await author.editScenario(current, instruction, { effort: opts.effort });
  try {
    compileScenarioContent(scenarioFieldsToMd(fields));
    return { kind: 'edit', ok: true, fields, summary, author: author.name };
  } catch (e) {
    return { kind: 'edit', ok: false, fields, summary, errors: (e as Error).message, author: author.name };
  }
}

// ── 5: the review/publish gate ────────────────────────────────────────────────

export interface PublishOptions {
  /** Who approved this draft for publish. Required — this is the review gate. */
  approvedBy: string;
  /** Where the source lives, for content_source/drift bookkeeping. */
  repoPath?: string;
  revision?: string | null;
  /** Owning user for the published content (RLS, SAU-229); null = platform. */
  ownerUserId?: string | null;
}

/**
 * Publish an approved scenario draft. Refuses unless the draft passed validation
 * AND an approver is named, then RE-COMPILES the exact MD (defense-in-depth — the
 * persisted row is always the product of a fresh compile, never a trusted blob)
 * before upserting. Returns the persisted scenario.
 */
export async function publishScenarioDraft(
  store: Store,
  draft: ScenarioDraft,
  opts: PublishOptions,
): Promise<ScenarioRecord> {
  assertApproved(opts);
  if (!draft.ok) {
    throw new AuthoringError(`cannot publish: generation failed validation\n${draft.errors ?? ''}`.trim());
  }
  const { scenario } = await persistScenarioMd(store, draft.md, opts);
  return scenario;
}

/**
 * Publish an approved course draft: persist every member scenario (each via a
 * fresh compile), then re-validate the course references against the persisted
 * slugs. Returns the compiled course + the persisted scenarios.
 *
 * NB: the course *manifest* (ordered membership) is the MD source of truth
 * (ADR-002). A durable `course` / `course_scenario` table is a separate slice
 * (Course CRUD / "Play All"); Slice 4 delivers a validated, working course whose
 * member scenarios are live and playable.
 */
export async function publishCourseDraft(
  store: Store,
  draft: CourseDraft,
  opts: PublishOptions,
): Promise<{ course: CompiledCourseRecord; scenarios: ScenarioRecord[] }> {
  assertApproved(opts);
  if (!draft.ok || !draft.course) {
    throw new AuthoringError(`cannot publish: course failed validation\n${draft.errors ?? ''}`.trim());
  }
  const scenarios: ScenarioRecord[] = [];
  for (const member of draft.scenarios) {
    const { scenario } = await persistScenarioMd(store, member.md, opts);
    scenarios.push(scenario);
  }
  // Re-validate references against what actually persisted (belt-and-suspenders).
  validateCourseReferences(draft.course, scenarios.map((s) => s.slug));
  return { course: draft.course, scenarios };
}

function assertApproved(opts: PublishOptions): void {
  if (!opts.approvedBy || !opts.approvedBy.trim()) {
    throw new AuthoringError('review gate: an explicit approver (approvedBy) is required before publishing AI-authored content');
  }
}

/** Fresh-compile MD and upsert it as a scenario + content_source. */
async function persistScenarioMd(
  store: Store,
  md: string,
  opts: PublishOptions,
): Promise<{ scenario: ScenarioRecord }> {
  const { record } = compileScenarioContent(md); // re-validate the exact bytes
  const res = await store.upsertScenarioFromCompile(record, {
    repoPath: opts.repoPath ?? `ai:${record.slug}.md`,
    contentHash: sha256(md),
    revision: opts.revision ?? null,
  }, { ownerUserId: opts.ownerUserId ?? null });
  return { scenario: res.scenario };
}

export { ScenarioCompileError, CourseCompileError };
