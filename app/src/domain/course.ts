/**
 * Course domain model + authoring (frontmatter) schema.
 *
 * A Course is a COMPOSITION over the Scenario atom (ADR-001): an ordered list of
 * Scenario refs with an optional Coach binding. It does NOT duplicate scenario
 * content — the members are scenario slugs whose order drives the "Play All"
 * sequence (ERD `course_scenario.position`). Authored as Markdown + YAML
 * frontmatter (ADR-002) and compiled into `course` + the ordered
 * `course_scenario` join.
 *
 * This is the single canonical Course domain after the Slice 1-4 integration
 * (SAU-210, ADR-006). It is the Slice-3 persistence model (`CourseRecord` DB
 * projection + `CompiledCourseRecord` carrying `coachRef`/`scenarioRefs`) with
 * the Slice-4 AI-authoring *input tolerances* folded in:
 *   - `scenario_ids` accepted as an alias for `scenarios`
 *   - members may be a bare slug OR an object `{ slug, position }`
 * The publish-gate invariant is preserved (SAU-210 ratification): a course MUST
 * list at least one scenario. The scenarios-optional *draft* tolerance lives
 * upstream in the authoring pipeline's pre-publish state — never here.
 */
import { z } from 'zod';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A course member: either a bare scenario slug (string) or an object carrying
 * an explicit position (Slice-4 input tolerance). Both normalize to an ordered
 * slug list.
 */
const courseScenarioRefSchema = z.union([
  z.string().regex(slugPattern, 'scenario ref must be a kebab-case slug'),
  z.object({
    slug: z.string().regex(slugPattern, 'scenario ref must be a kebab-case slug'),
    position: z.number().int().min(0).optional(),
  }),
]);

export const courseFrontmatterSchema = z
  .object({
    id: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    slug: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    // The ordered scenarios that make up the course (the Play All sequence).
    // `scenarios` is canonical; `scenario_ids` is accepted as an alias.
    scenarios: z.array(courseScenarioRefSchema).optional(),
    scenario_ids: z.array(courseScenarioRefSchema).optional(),
    /** optional coach binding (slug) */
    coach_ref: z.string().regex(slugPattern).optional(),
    coach: z.string().regex(slugPattern).optional(),
    visibility: z.enum(['public', 'private']).default('private'),
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((fm, ctx) => {
    if (!fm.id && !fm.slug) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frontmatter must define `id` (or `slug`)' });
    }
    // Publish-gate invariant (SAU-210 / ADR-006): a course MUST list >=1 scenario.
    // A 0-scenario course is not a working course and must not clear the gate.
    // (The scenarios-optional draft tolerance lives upstream in the authoring
    // pipeline, never in this compile/publish schema.)
    const refs = fm.scenarios ?? fm.scenario_ids;
    if (!refs || refs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scenarios'],
        message: 'a course must list at least one scenario (ordered)',
      });
    }
  });

export type CourseFrontmatter = z.infer<typeof courseFrontmatterSchema>;

// ── Canonical record (DB-row projection, camelCase) ──────────────────────────
export interface CourseRecord {
  id: string;
  slug: string;
  name: string;
  isPublic: boolean;
  coachId: string | null;
  /** ordered scenario ids, resolved from the join (position-sorted) */
  scenarioIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** The schema-valid, normalized projection a course frontmatter file compiles to. */
export interface CompiledCourseRecord {
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  /** coach slug (resolved to id at upsert) */
  coachRef: string | null;
  /** ordered scenario slugs — the "Play All" sequence (resolved to ids + positions at upsert) */
  scenarioRefs: string[];
  metadata: Record<string, unknown>;
}

const refToSlug = (ref: string | { slug: string }): string => (typeof ref === 'string' ? ref : ref.slug);

/**
 * Normalize validated course frontmatter into the canonical record. Members are
 * ordered by an explicit `position` when present, else by authoring order.
 * Duplicate slugs are rejected here — an ordered "Play All" with the same atom
 * twice is almost always an authoring mistake and breaks position semantics.
 */
export function normalizeCourseFrontmatter(fm: CourseFrontmatter): CompiledCourseRecord {
  const refs = (fm.scenarios ?? fm.scenario_ids ?? []).map((ref, i) => ({
    slug: refToSlug(ref),
    position: typeof ref === 'object' && ref.position !== undefined ? ref.position : i,
  }));
  refs.sort((a, b) => a.position - b.position);
  const scenarioRefs = refs.map((r) => r.slug);

  const dupes = scenarioRefs.filter((s, i) => scenarioRefs.indexOf(s) !== i);
  if (dupes.length) {
    throw new Error(`course lists duplicate scenario(s): ${[...new Set(dupes)].join(', ')}`);
  }

  return {
    slug: (fm.id ?? fm.slug)!,
    name: fm.name,
    description: fm.description ?? null,
    isPublic: fm.visibility === 'public',
    coachRef: (fm.coach_ref ?? fm.coach) ?? null,
    scenarioRefs,
    metadata: fm.metadata,
  };
}
