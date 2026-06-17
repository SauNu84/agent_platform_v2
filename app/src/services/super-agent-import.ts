/**
 * Super Agent — snapshot import of an existing Default agent as a sub-agent
 * (SAU-327, board ask on SAU-307).
 *
 * v1 is a SNAPSHOT (CTO decision): a picked Default agent is *copied* into a new
 * inline sub-agent row, then freely editable. There is no live link — editing the
 * sub-agent never touches the original, and editing the original later never
 * changes this sub-agent. That keeps the existing inline storage seam in
 * `@/domain/super-agent` unchanged (no migration, no `scenario_subagent` table,
 * no RLS/propagation rules) — the path the module header flags for "when
 * sub-agents become shareable" (live reference) is explicitly out of scope here.
 *
 * This module is PURE (the only dependency is the tool registry, for the
 * supported-tool intersection), so both the eligibility filter and the field
 * mapping are unit-testable away from the React form.
 */
import { TOOL_REGISTRY } from '@/domain/scenario';

/** Tool names a sub-agent can carry (the built-in registry the sub-agent form offers). */
const SUB_AGENT_TOOL_NAMES = new Set(Object.keys(TOOL_REGISTRY));

/** The minimal projection of a listed scenario this import needs. */
export interface ImportableAgent {
  slug: string;
  name: string;
  aiInstructions: string;
  tools: { name: string }[];
  metadata?: Record<string, unknown> | null;
}

/** The snapshot copied into a new sub-agent row (UI ids/keys added by the caller). */
export interface ImportedSubAgent {
  name: string;
  instructions: string;
  /** sub-agent tool names kept (those the sub-agent form supports). */
  tools: string[];
  /** preferred model id (advisory in v1 — see super-agent module header). */
  model: string;
  /** original tool names dropped because the sub-agent form can't carry them. */
  droppedTools: string[];
}

/**
 * The author's own Default agents that may be imported as a sub-agent: scoped to
 * user-authored scenarios (the Library "My Scenarios" convention, `_source: user`),
 * excluding Super Agents (no nesting one supervisor inside another) and the
 * scenario currently being edited (no self-nesting).
 */
export function selectImportableAgents<
  T extends { slug: string; metadata?: Record<string, unknown> | null },
>(scenarios: T[], currentSlug?: string | null): T[] {
  return scenarios.filter(
    (s) =>
      s.metadata?._source === 'user' &&
      s.metadata?._agentType !== 'super' &&
      s.slug !== currentSlug,
  );
}

/**
 * Map a Default agent to a snapshot sub-agent: name ← title (slug fallback),
 * instructions ← resolved persona/aiInstructions, tools ← the agent's tool names
 * intersected with what a sub-agent supports (the rest are reported in
 * `droppedTools` so the UI can surface a note), model ← `metadata._model` if set.
 * Returns a fresh object with its own `tools` array — mutating the result never
 * reaches the source agent (snapshot semantics, SAU-327 AC #4).
 */
export function buildSubAgentFromScenario(agent: ImportableAgent): ImportedSubAgent {
  const toolNames = Array.isArray(agent.tools) ? agent.tools.map((t) => t.name) : [];
  const tools = toolNames.filter((n) => SUB_AGENT_TOOL_NAMES.has(n));
  const droppedTools = toolNames.filter((n) => !SUB_AGENT_TOOL_NAMES.has(n));
  const model = typeof agent.metadata?._model === 'string' ? agent.metadata._model : '';
  return {
    name: agent.name?.trim() || agent.slug,
    instructions: agent.aiInstructions ?? '',
    tools,
    model,
    droppedTools,
  };
}
