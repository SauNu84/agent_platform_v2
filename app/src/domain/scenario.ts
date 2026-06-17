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
import {
  safeParseSuperAgentConfig, parseSuperAgentConfig, compileSuperAgentInstructions,
  superAgentToolNames, isSuperAgent, assertSuperAgentWithinLimits,
  SET_ACTIVE_SUBAGENT_TOOL, type SuperAgentConfig,
} from '@/domain/super-agent';

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

  // ── Action-taking (server-side) tools — SAU-267 clinic spike ──────────────
  // These have real side effects: they read/write a calendar via the adapter seam
  // and the clinic rules are enforced in the executor, not the prompt. Wired into
  // the realtime session and dispatched to /api/scenarios/[slug]/tools server-side.
  check_availability: {
    name: 'check_availability',
    description: 'Look up open appointment slots on the clinic calendar. Call this before offering times. Optionally narrow by doctor, service/appointment type, and/or a date range (ISO 8601). The result also lists the clinic\'s services and accepted insurance.',
    paramsSchema: {
      type: 'object',
      properties: {
        doctor: { type: 'string', description: 'Doctor name or id to narrow the search (optional).' },
        service: { type: 'string', description: 'Appointment type / service name or id; sets the visit length and restricts to providers who offer it (optional).' },
        from: { type: 'string', description: 'Earliest ISO 8601 datetime to consider (optional; defaults to now).' },
        to: { type: 'string', description: 'Latest ISO 8601 datetime to consider (optional; defaults to a week out).' },
      },
    },
    sideEffect: 'server',
  },
  create_appointment: {
    name: 'create_appointment',
    description: 'Create the appointment on the clinic calendar once the patient has confirmed a specific open slot. Returns the created event id. Clinic rules (hours, slot length, no double-booking) are enforced server-side and may reject the request.',
    paramsSchema: {
      type: 'object',
      properties: {
        patientName: { type: 'string', description: 'Full name of the patient.' },
        doctor: { type: 'string', description: 'The chosen doctor (name or id).' },
        service: { type: 'string', description: 'Appointment type / service (name or id); sets the visit length (optional).' },
        slotStart: { type: 'string', description: 'ISO 8601 start time of the confirmed slot.' },
        slotEnd: { type: 'string', description: 'ISO 8601 end time (optional; defaults to the service or clinic slot length).' },
        reason: { type: 'string', description: 'Reason for the visit.' },
        insurance: { type: 'string', description: 'Insurance plan the patient gave (optional).' },
        dob: { type: 'string', description: 'Patient date of birth (optional).' },
      },
      required: ['patientName', 'doctor', 'slotStart'],
    },
    sideEffect: 'server',
  },

  // ── Super Agent attribution marker — SAU-318 #4 ───────────────────────────
  // Advisory, UI-side-effect marker the supervisor calls when it switches which
  // sub-agent is active, so the session History can attribute turns. No server
  // executor; handled client-side (recorded into the session toolCalls). ADVISORY
  // ONLY (CTO #4): the model may switch without calling it — never gate, bill, or
  // route on it. Auto-folded into a Super Agent's tool union (resolveScenarioTools).
  [SET_ACTIVE_SUBAGENT_TOOL]: {
    name: SET_ACTIVE_SUBAGENT_TOOL,
    description:
      'Advisory attribution marker: call this whenever you switch which sub-agent is currently active (including the ' +
      'first), passing that sub-agent’s name. It records which sub-agent handled the turn for the session History and ' +
      'has NO effect on the conversation — switch and respond normally whether or not you call it.',
    paramsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the sub-agent you are switching to (as listed in your sub-agents manifest).' },
      },
      required: ['name'],
    },
    sideEffect: 'ui',
  },
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

/**
 * Validate the agent-type config on a record's metadata at WRITE time (SAU-307),
 * so the API can never persist a Super Agent the runtime couldn't compile. No-op
 * for default agents. Throws on a malformed supervisor/sub-agent config or a
 * sub-agent tool name that isn't in the registry. Returns the parsed config (or
 * null) for callers that want it.
 */
export function validateAgentTypeMetadata(metadata: Record<string, unknown> | undefined): SuperAgentConfig | null {
  if (!isSuperAgent(metadata)) return null;
  // Strict parse: throws SuperAgentConfigError (a readable message) on any issue.
  const cfg = parseSuperAgentConfig(metadata?._superAgent);
  // Tool names must resolve against the built-in registry (same rule as default
  // agents' `tools`); resolveTool throws on an unknown name.
  for (const name of superAgentToolNames(cfg)) resolveTool(name);
  // SAU-318 #3: cap team size + composed-prompt size so a runaway supervisor can't
  // be persisted (latency/voice-COGS guardrail). Throws SuperAgentConfigError.
  assertSuperAgentWithinLimits(cfg);
  return cfg;
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
export interface ModelInstructionsOptions {
  /**
   * Knowledge Base text (SAU-243): the bounded, deterministically-ordered block
   * of linked-KB document text, ALREADY assembled + budget-capped by
   * `assembleKnowledgeBaseContext`. Passed in (not resolved here) so this domain
   * function stays pure: the async store read + truncation logging live in the
   * caller (services/knowledge-base). Folded in AFTER Additional Context.
   */
  knowledgeBaseText?: string;
}

export function modelInstructions(
  rec: { aiInstructions: string; metadata?: Record<string, unknown> },
  opts?: ModelInstructionsOptions,
): string {
  const desc = typeof rec.metadata?._aiDescription === 'string' ? rec.metadata._aiDescription.trim() : '';
  // "Additional Context for AI" (SAU-238 ask #7): reference material the author
  // attached (e.g. fetched from a URL). Grounding context → improves answers.
  const context = typeof rec.metadata?._aiContext === 'string' ? rec.metadata._aiContext.trim() : '';
  const kb = typeof opts?.knowledgeBaseText === 'string' ? opts.knowledgeBaseText.trim() : '';
  // Super Agent (SAU-307): when authored as a supervisor, the head of the prompt
  // is the COMPILED supervisor+sub-agents coordination prompt (not the persona /
  // single-agent path). Context + KB still fold in below, unchanged. A malformed
  // config tolerantly falls back to the default path (runtime stays resilient;
  // create-time validation is the real gate — see services/scenarios.ts).
  const superCfg = isSuperAgent(rec.metadata) ? safeParseSuperAgentConfig(rec.metadata?._superAgent) : null;
  const head = superCfg ? compileSuperAgentInstructions(superCfg) : '';
  const parts = head ? [head] : [desc, rec.aiInstructions];
  if (context) parts.push(`## Reference context\nUse the following background as ground truth where relevant:\n\n${context}`);
  // Knowledge Base (SAU-243): reusable, multi-document corpus linked to this
  // scenario. Appended last, after Additional Context, so the per-scenario
  // context still leads. Already bounded by KB_CONTEXT_CHAR_BUDGET upstream.
  if (kb) parts.push(`## Knowledge base\nReference documents linked to this scenario. Treat as ground truth where relevant:\n\n${kb}`);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Resolve the tools the realtime session should expose for a record. For a Super
 * Agent (SAU-307) this is the UNION of every sub-agent's tools (deduped by name,
 * resolved against the registry) merged with any scenario-level tools — the one
 * session needs the whole team's toolset available. Plus the advisory
 * `set_active_subagent` attribution marker (SAU-318 #4), always available to a
 * supervisor so it can mark switches. Unknown tool names are skipped here
 * (create-time validation already rejects them). Default agents just use their
 * own tools.
 */
export function resolveScenarioTools(rec: ScenarioRecord): ToolDefinition[] {
  const cfg: SuperAgentConfig | null = isSuperAgent(rec.metadata)
    ? safeParseSuperAgentConfig(rec.metadata?._superAgent)
    : null;
  if (!cfg) return rec.tools;
  const byName = new Map<string, ToolDefinition>();
  for (const t of rec.tools) byName.set(t.name, t);
  for (const name of superAgentToolNames(cfg)) {
    if (byName.has(name)) continue;
    const found = TOOL_REGISTRY[name];
    if (found) byName.set(name, found);
  }
  // SAU-318 #4: fold in the attribution marker for every Super Agent.
  if (!byName.has(SET_ACTIVE_SUBAGENT_TOOL)) byName.set(SET_ACTIVE_SUBAGENT_TOOL, TOOL_REGISTRY[SET_ACTIVE_SUBAGENT_TOOL]);
  return [...byName.values()];
}

/** Project a canonical record into the realtime voice seam's CompiledScenario. */
export function toCompiledScenario(rec: ScenarioRecord, opts?: ModelInstructionsOptions): CompiledScenario {
  return {
    id: rec.id,
    name: rec.name,
    aiInstructions: modelInstructions(rec, opts),
    voice: { name: rec.voiceName, languageCode: rec.languageCode },
    tools: resolveScenarioTools(rec),
    rubric: rec.rubric,
  };
}

// ── Knowledge Base injection (SAU-243, Phase 1) ──────────────────────────────
/**
 * Global cap on the total linked-KB text folded into ANY one scenario's system
 * prompt, across all its linked knowledge bases (~150k chars ≈ ~38k tokens).
 * This — not RAG — is what protects the context window and cost in Phase 1; at
 * our measured prompt-cache hit rate a bounded static block sits in the cached
 * prefix. RAG only becomes necessary once a single linked KB exceeds this
 * budget (the Phase-2 trigger, per the spec).
 */
export const KB_CONTEXT_CHAR_BUDGET = 150_000;

/** A linked-KB document reduced to what the prompt needs: a label + its text. */
export interface KnowledgeBaseDoc {
  filename: string;
  text: string;
}

export interface AssembledKnowledge {
  /** The joined, bounded reference block (empty when no usable text). */
  text: string;
  chars: number;
  /** True when the budget cut off one or more documents (a marker was appended). */
  truncated: boolean;
}

const KB_TRUNCATION_MARKER =
  '\n\n[… knowledge base truncated at the context budget — remaining linked documents omitted …]';

/**
 * Pure, deterministic assembly of linked-KB docs into one bounded block.
 * Docs are consumed in the order given (the store yields a deterministic order:
 * link order, then document upload order). Total text is capped at `budget`;
 * past the cap we keep a partial slice of the doc that crossed it (if a useful
 * amount fits) and append a VISIBLE truncation marker — never silent overflow
 * (AC #4). Returns `{ text, chars, truncated }` so the caller can log the cut.
 */
export function assembleKnowledgeBaseContext(
  docs: KnowledgeBaseDoc[],
  budget: number = KB_CONTEXT_CHAR_BUDGET,
): AssembledKnowledge {
  const pieces: string[] = [];
  let used = 0;
  let truncated = false;
  for (const doc of docs) {
    const body = (doc.text ?? '').trim();
    if (!body) continue;
    const header = `### ${(doc.filename || 'Document').trim()}\n`;
    const piece = `${header}${body}`;
    const sep = pieces.length ? 2 : 0; // '\n\n' join cost
    if (used + sep + piece.length > budget) {
      const room = budget - used - sep - header.length;
      if (room > 200) pieces.push(`${header}${body.slice(0, room).trimEnd()}`);
      truncated = true;
      break;
    }
    pieces.push(piece);
    used += sep + piece.length;
  }
  let text = pieces.join('\n\n');
  if (truncated) text += KB_TRUNCATION_MARKER;
  return { text, chars: text.length, truncated };
}
