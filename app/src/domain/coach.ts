/**
 * Coach domain model + authoring (frontmatter) schema.
 *
 * A Coach is a COMPOSITION over the Scenario atom (ADR-001): Scenario + persistent
 * per-user memory (ADR-004) + a schedule/recurrence + Join. It does NOT duplicate
 * persona/voice/rubric — it references a Scenario by slug (`scenario_ref`) and the
 * detail UI resolves presentation from that scenario. Authored as Markdown + YAML
 * frontmatter (ADR-002) and compiled into the canonical `coach` row.
 *
 * (Inline-persona coaches — `inline_ai_instructions` that compile down to a backing
 * scenario — are reserved in the ERD and deferred past the Slice-3 MVP.)
 */
import { z } from 'zod';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Schedule / recurrence (ADR-004 §schedule; coach.schedule jsonb) ───────────
export const coachScheduleSchema = z.object({
  cadence: z.enum(['none', 'daily', 'weekly']).default('none'),
  /** every N days (daily) or N weeks (weekly); default 1 */
  interval: z.number().int().min(1).max(52).default(1),
  /** weekly only: 0=Sun … 6=Sat */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  /** local clock time 'HH:MM' (24h) the session is suggested */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  timezone: z.string().min(1).default('UTC'),
  /** delivery channels for the reminder (e.g. in_app, email) */
  channels: z.array(z.string().min(1)).default([]),
});

export type CoachSchedule = z.infer<typeof coachScheduleSchema>;

// ── Authoring schema (frontmatter) ───────────────────────────────────────────
export const coachFrontmatterSchema = z
  .object({
    id: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    slug: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    name: z.string().min(1),
    /** slug of the Scenario this coach composes (the atom; ADR-001) */
    scenario_ref: z.string().regex(slugPattern, 'scenario_ref must be a scenario slug').optional(),
    /** alias */
    scenario: z.string().regex(slugPattern).optional(),
    memory_scope: z.enum(['per_user']).default('per_user'),
    retention: z.enum(['persistent', 'window']).default('persistent'),
    schedule: coachScheduleSchema.default({}),
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((fm, ctx) => {
    if (!fm.id && !fm.slug) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frontmatter must define `id` (or `slug`)' });
    }
    if (!fm.scenario_ref && !fm.scenario) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frontmatter must define `scenario_ref` (the scenario slug this coach composes)' });
    }
  });

export type CoachFrontmatter = z.infer<typeof coachFrontmatterSchema>;

// ── Canonical record (DB-row projection, camelCase) ──────────────────────────
export interface CoachRecord {
  id: string;
  slug: string;
  name: string;
  scenarioId: string | null;
  inlineAiInstructions: string | null;
  memoryScope: 'per_user';
  retention: 'persistent' | 'window';
  schedule: CoachSchedule;
  /** owning user (null = platform/seeded content); enforced by RLS (SAU-229) */
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Compiled projection: still carries the scenario *ref* (slug) because the
 * scenario UUID is resolved at upsert time by the store. `metadata` is carried
 * for authoring convenience but is not persisted on the coach row (presentation
 * metadata lives on the composed scenario).
 */
export interface CompiledCoachRecord {
  slug: string;
  name: string;
  scenarioRef: string | null;
  inlineAiInstructions: string | null;
  memoryScope: 'per_user';
  retention: 'persistent' | 'window';
  schedule: CoachSchedule;
}

export function normalizeCoachFrontmatter(fm: CoachFrontmatter): CompiledCoachRecord {
  return {
    slug: (fm.id ?? fm.slug)!,
    name: fm.name,
    scenarioRef: (fm.scenario_ref ?? fm.scenario) ?? null,
    inlineAiInstructions: null,
    memoryScope: fm.memory_scope,
    retention: fm.retention,
    schedule: fm.schedule,
  };
}
