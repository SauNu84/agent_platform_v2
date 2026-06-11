/**
 * Scenario domain model + the authoring (frontmatter) schema.
 *
 * The Scenario is the core primitive (ADR-001). It is authored as Markdown +
 * YAML frontmatter (ADR-002) and compiled into the canonical `scenario` row.
 * This file owns:
 *   - the Zod schema for the *authoring surface* (frontmatter),
 *   - the canonical `ScenarioRecord` (the DB-row shape, camelCase in TS),
 *   - the mapping to `CompiledScenario` consumed by the realtime voice seam.
 */
import { z } from 'zod';
import type { CompiledScenario, ToolDefinition } from '@/voice/realtime-interface';

// ── Built-in multimodal tool registry (ADR-005, minimal Slice-1 surface) ─────
// Frontmatter may list tools by name (`tools: [slides, whiteboard]`) OR inline a
// full ToolDefinition object. Named tools resolve against this registry. The
// full tool protocol/handlers land with ADR-005 work; Slice 1 only needs the
// definition so the agent can be told the tool exists.
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  slides: { name: 'slides', description: 'Navigate or render presentation slides.', paramsSchema: { type: 'object', properties: { op: { type: 'string' }, index: { type: 'number' } } }, sideEffect: 'ui' },
  whiteboard: { name: 'whiteboard', description: 'Draw or annotate on a shared whiteboard.', paramsSchema: { type: 'object', properties: { op: { type: 'string' }, shape: { type: 'string' } } }, sideEffect: 'ui' },
  code: { name: 'code', description: 'Open or edit code in a shared editor.', paramsSchema: { type: 'object', properties: { op: { type: 'string' }, content: { type: 'string' } } }, sideEffect: 'ui' },
  cards: { name: 'cards', description: 'Present an informational card to the learner.', paramsSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } }, sideEffect: 'ui' },
};

// ── Authoring schema (frontmatter) ───────────────────────────────────────────
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const rubricItemSchema = z.object({
  topic: z.string().min(1),
  weight: z.number().min(0).max(100),
  note: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  paramsSchema: z.record(z.unknown()).default({}),
  sideEffect: z.enum(['ui', 'server', 'both']).default('ui'),
});

/** Accept a named tool (resolved against the registry) or an inline definition. */
const toolRefSchema = z.union([z.string().min(1), toolDefinitionSchema]);

export const scenarioFrontmatterSchema = z
  .object({
    // `id` is the stable key (also used as slug); accept `slug` as an alias.
    id: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    slug: z.string().regex(slugPattern, 'id/slug must be kebab-case').optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    // `persona` is the canonical author field; `ai_instructions` accepted as alias.
    persona: z.string().min(1).optional(),
    ai_instructions: z.string().min(1).optional(),
    rubric: z.array(rubricItemSchema).default([]),
    voice: z
      .object({
        name: z.string().min(1).default('alloy'),
        language: z.string().min(1).default('en-US'),
      })
      .default({ name: 'alloy', language: 'en-US' }),
    tools: z.array(toolRefSchema).default([]),
    visibility: z.enum(['public', 'private']).default('private'),
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((fm, ctx) => {
    if (!fm.id && !fm.slug) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frontmatter must define `id` (or `slug`)' });
    }
    if (!fm.persona && !fm.ai_instructions) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frontmatter must define `persona` (or `ai_instructions`)' });
    }
  });

export type ScenarioFrontmatter = z.infer<typeof scenarioFrontmatterSchema>;

// ── Canonical record (the DB-row projection, camelCase) ──────────────────────
export interface RubricItem {
  topic: string;
  weight: number;
  note?: string;
}

export interface ScenarioRecord {
  id: string;          // uuid (assigned by DB on first upsert)
  slug: string;        // stable key from frontmatter id/slug
  name: string;
  description: string | null;
  aiInstructions: string;
  rubric: RubricItem[];
  isPublic: boolean;
  voiceName: string;
  languageCode: string;
  tools: ToolDefinition[];
  metadata: Record<string, unknown>;
  /** owning user (null = platform/seeded content); enforced by RLS (SAU-229) */
  ownerUserId: string | null;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
}

/** The schema-valid, normalized projection a frontmatter file compiles to. */
export interface CompiledScenarioRecord {
  slug: string;
  name: string;
  description: string | null;
  aiInstructions: string;
  rubric: RubricItem[];
  isPublic: boolean;
  voiceName: string;
  languageCode: string;
  tools: ToolDefinition[];
  metadata: Record<string, unknown>;
}

/** Resolve a tool ref (name or inline def) to a full ToolDefinition. */
export function resolveTool(ref: string | ToolDefinition): ToolDefinition {
  if (typeof ref === 'string') {
    const found = TOOL_REGISTRY[ref];
    if (!found) {
      throw new Error(`unknown tool "${ref}" — not in the built-in registry (${Object.keys(TOOL_REGISTRY).join(', ')})`);
    }
    return found;
  }
  return ref;
}

/**
 * Normalize validated frontmatter (+ markdown body) into the canonical record.
 * The body is appended to the persona as additional briefing/reference context
 * the agent may use — per the design (§4: "Body = optional briefing/context").
 */
export function normalizeFrontmatter(fm: ScenarioFrontmatter, body: string): CompiledScenarioRecord {
  const persona = (fm.persona ?? fm.ai_instructions ?? '').trim();
  const briefing = body.trim();
  const aiInstructions = briefing ? `${persona}\n\n## Reference briefing\n${briefing}` : persona;
  return {
    slug: (fm.id ?? fm.slug)!,
    name: fm.name,
    description: fm.description ?? null,
    aiInstructions,
    rubric: fm.rubric,
    isPublic: fm.visibility === 'public',
    voiceName: fm.voice.name,
    languageCode: fm.voice.language,
    tools: fm.tools.map(resolveTool),
    metadata: fm.metadata,
  };
}

/**
 * The instructions the MODEL actually receives (SAU-238). The author-facing
 * "Description for AI" (the persona identity, stored in `metadata._aiDescription`)
 * is prepended to the detailed AI Instructions to form one system prompt — used by
 * BOTH text chat and live voice. The "User Instruction" (`metadata._userInstructions`)
 * is deliberately NOT here: it is the human learner's brief, shown in the UI only,
 * so it never biases the agent.
 */
export function modelInstructions(rec: { aiInstructions: string; metadata?: Record<string, unknown> }): string {
  const desc = typeof rec.metadata?._aiDescription === 'string' ? rec.metadata._aiDescription.trim() : '';
  return [desc, rec.aiInstructions].filter(Boolean).join('\n\n');
}

/** Project a canonical record into the realtime voice seam's CompiledScenario. */
export function toCompiledScenario(rec: ScenarioRecord): CompiledScenario {
  return {
    id: rec.id,
    name: rec.name,
    aiInstructions: modelInstructions(rec),
    voice: { name: rec.voiceName, languageCode: rec.languageCode },
    tools: rec.tools,
    rubric: rec.rubric,
  };
}
