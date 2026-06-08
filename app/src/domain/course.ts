/**
 * Course domain model + the authoring (frontmatter) schema.
 *
 * A Course is a *composition* over the Scenario atom (ADR-001): it does NOT
 * duplicate persona/voice/rubric — it lists an ordered set of scenario slugs
 * (the "Play All" sequence, ERD `course_scenario.position`) plus a course-level
 * name/description/visibility. Like the Scenario, it is authored as Markdown +
 * YAML frontmatter (ADR-002) and validated by a compiler before it can be used.
 *
 * This file owns the Zod schema for the authoring surface and the canonical
 * `CompiledCourseRecord` it normalizes to. Course-row *persistence* (a `course`
 * table + `course_scenario` join) is a separate slice; Slice 4 (AI authoring)
 * only needs the validated content artifact + its member scenarios.
 */
import { z } from 'zod';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A course member: either a bare scenario slug (string) or an object carrying
 * an explicit position. Both normalize to an ordered slug list.
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
    // The ordered scenarios that make up the course. `scenarios` is canonical;
    // `scenario_ids` is accepted as an alias.
    scenarios: z.array(courseScenarioRefSchema).optional(),
    scenario_ids: z.array(courseScenarioRefSchema).optional(),
    visibility: z.enum(['public', 'private']).default('private'),
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((fm, ctx) => {
    if (!fm.id && !fm.slug) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frontmatter must define `id` (or `slug`)' });
    }
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

/** The schema-valid, normalized projection a course frontmatter file compiles to. */
export interface CompiledCourseRecord {
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  /** Ordered scenario slugs — the "Play All" sequence. */
  scenarioSlugs: string[];
  metadata: Record<string, unknown>;
}

const refToSlug = (ref: string | { slug: string }): string => (typeof ref === 'string' ? ref : ref.slug);

/**
 * Normalize validated course frontmatter (+ markdown body) into the canonical
 * record. Members are ordered by an explicit `position` when present, else by
 * authoring order; the body is dropped (course briefing lives on the scenarios).
 * Duplicate slugs are rejected here — an ordered "Play All" with the same atom
 * twice is almost always an authoring mistake and breaks position semantics.
 */
export function normalizeCourseFrontmatter(fm: CourseFrontmatter): CompiledCourseRecord {
  const refs = (fm.scenarios ?? fm.scenario_ids ?? []).map((ref, i) => ({
    slug: refToSlug(ref),
    position: typeof ref === 'object' && ref.position !== undefined ? ref.position : i,
  }));
  refs.sort((a, b) => a.position - b.position);
  const scenarioSlugs = refs.map((r) => r.slug);

  const dupes = scenarioSlugs.filter((s, i) => scenarioSlugs.indexOf(s) !== i);
  if (dupes.length) {
    throw new Error(`course lists duplicate scenario(s): ${[...new Set(dupes)].join(', ')}`);
  }

  return {
    slug: (fm.id ?? fm.slug)!,
    name: fm.name,
    description: fm.description ?? null,
    isPublic: fm.visibility === 'public',
    scenarioSlugs,
    metadata: fm.metadata,
  };
}
