/**
 * Course domain model + authoring (frontmatter) schema.
 *
 * A Course is a COMPOSITION over the Scenario atom (ADR-001): an ordered list of
 * Scenario refs with an optional Coach binding. It does NOT duplicate scenario
 * content — `scenarios:` is a list of scenario slugs whose order drives the
 * "Play All" sequence. Authored as Markdown + YAML frontmatter (ADR-002) and
 * compiled into `course` + the ordered `course_scenario` join.
 */
import { z } from 'zod';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const courseFrontmatterSchema = z
  .object({
    id: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    slug: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    /** ordered list of scenario slugs (the Play All sequence) */
    scenarios: z.array(z.string().regex(slugPattern, 'each scenario must be a slug')).min(1),
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
    const dupes = fm.scenarios.filter((s, i) => fm.scenarios.indexOf(s) !== i);
    if (dupes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `scenarios must be unique; duplicates: ${[...new Set(dupes)].join(', ')}` });
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

export interface CompiledCourseRecord {
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  /** coach slug (resolved to id at upsert) */
  coachRef: string | null;
  /** ordered scenario slugs (resolved to ids + positions at upsert) */
  scenarioRefs: string[];
  metadata: Record<string, unknown>;
}

export function normalizeCourseFrontmatter(fm: CourseFrontmatter): CompiledCourseRecord {
  return {
    slug: (fm.id ?? fm.slug)!,
    name: fm.name,
    description: fm.description ?? null,
    isPublic: fm.visibility === 'public',
    coachRef: (fm.coach_ref ?? fm.coach) ?? null,
    scenarioRefs: fm.scenarios,
    metadata: fm.metadata,
  };
}
