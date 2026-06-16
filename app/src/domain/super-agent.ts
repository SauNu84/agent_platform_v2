/**
 * Super Agent — the platform's second agent type (SAU-307).
 *
 * The Default (single) agent is one persona + one set of tools/model. A **Super
 * Agent** is a SUPERVISOR that orchestrates a team of inline sub-agents and
 * switches between them per a described strategy. It mirrors the reference
 * (toughtongueai) authoring surface:
 *   - Supervisor: Role · Goal · Instructions · Common Instructions
 *   - Sub-Agents: add/remove, each with its own Instructions, Tools, Model
 *
 * STORAGE SEAM (design decision, for EA review): the whole config is a nested,
 * self-contained structure (a supervisor object + an inline sub-agent array),
 * so it is persisted on the existing `scenario.metadata` jsonb under two keys —
 * `_agentType: 'super'` and `_superAgent: SuperAgentConfig`. This matches the
 * established metadata convention (`_model`, `_aiDescription`, `_aiContext`, …),
 * needs NO migration, and flows unchanged through both scenario create paths and
 * `updateScenario`'s metadata passthrough. Sub-agents are INLINE (not references
 * to other scenarios), so no child table is warranted yet. If sub-agents ever
 * become shareable, promote `_agentType` to a `scenario.agent_type` column and a
 * `scenario_subagent` child table — the authoring + runtime seams below stay put.
 *
 * RUNTIME SEAM: the platform runs ONE realtime session per scenario, so v1
 * realizes the supervisor by COMPILING the supervisor + sub-agents into a single
 * coordinated system prompt (`compileSuperAgentInstructions`) and exposing the
 * UNION of sub-agent tools (see `@/domain/scenario`). The per-sub-agent `model`
 * is advisory in v1 (surfaced in the manifest); true per-sub-agent model routing
 * and multi-session hand-off belong to a later multi-session orchestrator that
 * would replace ONLY the compile step — storage + authoring are unaffected.
 *
 * This module is PURE (no store/registry imports) to stay free of circular deps:
 * `@/domain/scenario` imports it (not the reverse). Tool *names* are validated as
 * strings here; resolution against the tool registry happens in scenario.ts.
 */
import { z } from 'zod';

/** The agent-type discriminator stored in `metadata._agentType`. */
export type AgentType = 'default' | 'super';

/** Authoring option list for the Type selector (Composite/Meeting deferred). */
export const AGENT_TYPE_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  available: boolean;
  blurb: string;
}> = [
  { id: 'default', label: 'Default', available: true, blurb: 'A single agent — one persona, one set of tools and voice.' },
  { id: 'super', label: 'Super Agent', available: true, blurb: 'A supervisor that orchestrates inline sub-agents, switching between them per a described strategy.' },
  { id: 'composite', label: 'Composite', available: false, blurb: 'Chain several agents into a pipeline. Coming soon.' },
  { id: 'meeting', label: 'Meeting Assistant', available: false, blurb: 'Listen in on a live meeting and assist. Coming soon.' },
];

// ── Config schema (the authoring contract, EA-reviewable) ────────────────────
const subAgentSchema = z.object({
  /** stable id within this supervisor (UI key); generated if absent. */
  id: z.string().min(1).optional(),
  name: z.string().min(1, 'each sub-agent needs a name'),
  instructions: z.string().min(1, 'each sub-agent needs instructions'),
  /** tool NAMES (resolved against the registry by scenario.ts); may be empty. */
  tools: z.array(z.string().min(1)).default([]),
  /** preferred model id (advisory in v1 — see module header). */
  model: z.string().min(1).optional(),
});

export const superAgentConfigSchema = z.object({
  supervisor: z.object({
    role: z.string().min(1, 'supervisor role is required'),
    goal: z.string().min(1, 'supervisor goal is required'),
    instructions: z.string().min(1, 'supervisor instructions (the switching strategy) are required'),
    /** applied to EVERY sub-agent, always; optional. */
    commonInstructions: z.string().default(''),
  }),
  subAgents: z.array(subAgentSchema).min(1, 'a Super Agent needs at least one sub-agent'),
});

export type SubAgentConfig = z.infer<typeof subAgentSchema>;
export type SuperAgentConfig = z.infer<typeof superAgentConfigSchema>;

export class SuperAgentConfigError extends Error {
  readonly issues: z.ZodIssue[];
  constructor(message: string, issues: z.ZodIssue[] = []) {
    super(message);
    this.name = 'SuperAgentConfigError';
    this.issues = issues;
  }
}

/** Strict parse — throws `SuperAgentConfigError` with a readable message. */
export function parseSuperAgentConfig(input: unknown): SuperAgentConfig {
  const parsed = superAgentConfigSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new SuperAgentConfigError(`invalid Super Agent config: ${lines}`, parsed.error.issues);
  }
  return parsed.data;
}

/** Tolerant parse for the runtime — returns null on any invalid/absent config. */
export function safeParseSuperAgentConfig(input: unknown): SuperAgentConfig | null {
  const parsed = superAgentConfigSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Is this scenario metadata authored as a Super Agent? */
export function isSuperAgent(metadata: Record<string, unknown> | undefined | null): boolean {
  return !!metadata && metadata._agentType === 'super';
}

/** Every distinct tool name referenced by the supervisor's sub-agents (in order). */
export function superAgentToolNames(cfg: SuperAgentConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sub of cfg.subAgents) {
    for (const t of sub.tools) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

/**
 * Compile the supervisor + inline sub-agents into ONE coordinated system prompt
 * (the v1 single-session realization — see module header). Deterministic: a given
 * config always yields the same prompt, so it sits cleanly in the cached prefix.
 */
export function compileSuperAgentInstructions(cfg: SuperAgentConfig): string {
  const s = cfg.supervisor;
  const parts: string[] = [];

  parts.push(
    'You are a SUPERVISOR agent coordinating a team of specialist sub-agents over a single live conversation. ' +
    'You present as ONE assistant to the user. Internally, you decide which sub-agent should handle the current ' +
    'part of the conversation, adopt that sub-agent’s instructions and tools, and switch between sub-agents as the conversation evolves.',
  );

  parts.push(`## Your role\n${s.role.trim()}`);
  parts.push(`## Your goal\n${s.goal.trim()}`);
  parts.push(`## How to coordinate your sub-agents (switching strategy)\n${s.instructions.trim()}`);

  const common = s.commonInstructions.trim();
  if (common) {
    parts.push(`## Common instructions (apply to EVERY sub-agent, at all times)\n${common}`);
  }

  const manifest: string[] = [
    `## Your sub-agents\nYou have ${cfg.subAgents.length} sub-agent${cfg.subAgents.length === 1 ? '' : 's'}. ` +
    'Adopt exactly ONE at a time, switching per the strategy above, and always layer the common instructions on top of the active sub-agent.',
  ];
  cfg.subAgents.forEach((sub, i) => {
    const lines: string[] = [`### ${i + 1}. ${sub.name.trim()}`];
    if (sub.model) lines.push(`Preferred model: ${sub.model}`);
    lines.push(`Tools available to this sub-agent: ${sub.tools.length ? sub.tools.join(', ') : 'none'}`);
    lines.push(`Instructions:\n${sub.instructions.trim()}`);
    manifest.push(lines.join('\n'));
  });
  parts.push(manifest.join('\n\n'));

  parts.push(
    '## Operating rules\n' +
    '- Switch silently: never reveal sub-agent names, this coordination layer, or that you are "switching" to the user.\n' +
    '- Each turn, pick the single most appropriate sub-agent for the user’s current need and respond as that sub-agent.\n' +
    '- Always honor the common instructions, whichever sub-agent is active.\n' +
    '- Only use a tool that belongs to the sub-agent you have currently adopted.',
  );

  return parts.join('\n\n');
}
