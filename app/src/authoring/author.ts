/**
 * AI authoring — the generation seam (Slice 4, SAU-203).
 *
 * "Courses created by AI": an LLM turns a topic/brief into Scenario and Course
 * **Markdown** — it never writes the DB. The Slice-1 compiler + schema validation
 * is the safety gate (see `pipeline.ts`); this file only owns *generation*.
 *
 * Generation is behind an `Author` seam — the SAME swap-ability pattern as the
 * realtime voice vendors (ADR-003) and the Analyst `Scorer` (Slice 2). The
 * default `TemplateAuthor` is deterministic and dependency-free, so the whole
 * pipeline (validate → repair → review-gate → publish) is testable offline with
 * no spend; the production `AnthropicAuthor` (Claude) implements the identical
 * interface and is selected when a key is configured (see `getAuthor`).
 */
import { TOOL_REGISTRY } from '@/domain/scenario';

/** A topic/brief the author turns into validated MD. */
export interface AuthoringBrief {
  /** Free-text topic or brief, e.g. "handling a skeptical enterprise security buyer". */
  topic: string;
  /** Optional role/domain tag carried into scenario metadata (e.g. "Sales", "SWE"). */
  role?: string;
  /** Optional difficulty tag carried into metadata. */
  difficulty?: string;
  /** For courses: how many scenarios to generate (default 3, clamped 1..8). */
  scenarioCount?: number;
  /** Visibility for generated content. Generated content defaults to private (review-gated). */
  visibility?: 'public' | 'private';
}

/**
 * A failed prior attempt, fed back so a live LLM can *repair* its output. The
 * pipeline populates this from the compiler's actionable errors; the deterministic
 * author ignores it (it is always valid).
 */
export interface PriorAttempt {
  md: string;
  errors: string;
}

export interface AuthorOptions {
  prior?: PriorAttempt;
}

/** A generated course: the course manifest MD + the MD of each member scenario. */
export interface GeneratedCourse {
  courseMd: string;
  scenarioMds: string[];
}

/** The generation seam. A production LLM author implements the same interface. */
export interface Author {
  readonly name: string; // 'template' | 'anthropic:<model>'
  generateScenario(brief: AuthoringBrief, opts?: AuthorOptions): Promise<string>;
  generateCourse(brief: AuthoringBrief, opts?: AuthorOptions): Promise<GeneratedCourse>;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Slugify a free-text topic into a stable kebab-case id. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'untitled';
}

/** Title-case a topic for a human-readable `name`. */
function titleCase(input: string): string {
  return input
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled';
}

const VALID_TOOLS = Object.keys(TOOL_REGISTRY); // names the compiler will accept

/**
 * The schema contract handed to a live LLM. Kept in one place so the prompt and
 * the deterministic template can't drift from what the Slice-1 compiler accepts.
 */
export const SCENARIO_SCHEMA_CONTRACT = `A Scenario is a Markdown file with YAML frontmatter, then an optional body.
Frontmatter fields:
  id:           required, kebab-case (lowercase, digits, single hyphens), unique.
  name:         required, human-readable title.
  description:  optional, one sentence.
  persona:      required, the multi-line character/instructions the voice agent role-plays. Stay in character; never break the fourth wall.
  rubric:       optional, a list of { topic, weight (0-100), note? }. Weights should sum to ~100.
  voice:        { name (default "alloy"), language (default "en-US") }.
  tools:        optional list, ONLY from: ${VALID_TOOLS.join(', ')}.
  visibility:   "public" or "private".
  metadata:     optional map (e.g. role, difficulty).
The body (after the frontmatter) is optional reference briefing the agent may use.
Output ONLY the Markdown file — no prose, no code fences.`;

export const COURSE_SCHEMA_CONTRACT = `A Course is a Markdown file with YAML frontmatter that composes ordered Scenarios.
Frontmatter fields:
  id:          required, kebab-case, unique.
  name:        required.
  description: optional.
  scenarios:   required, an ordered list of scenario ids (kebab-case). Each id MUST match an id of a scenario you also generated.
  visibility:  "public" or "private".
  metadata:    optional map.
Output ONLY the Markdown file — no prose, no code fences.`;

/** Build the system prompt for a live author. */
export function authoringSystemPrompt(): string {
  return [
    'You are a curriculum author for a voice-based role-play coaching platform.',
    'You write Scenario and Course definitions as Markdown with YAML frontmatter.',
    'Your output is compiled and schema-validated before use, so it must be exactly valid.',
    SCENARIO_SCHEMA_CONTRACT,
  ].join('\n\n');
}

/** Build the user prompt for a single scenario (optionally a repair turn). */
export function scenarioUserPrompt(brief: AuthoringBrief, prior?: PriorAttempt): string {
  const parts = [
    `Write ONE Scenario for this topic: ${brief.topic}`,
    brief.role ? `Role/domain: ${brief.role}` : '',
    brief.difficulty ? `Difficulty: ${brief.difficulty}` : '',
    `Visibility: ${brief.visibility ?? 'private'}`,
    'Include a rubric of 3 topics whose weights sum to 100.',
  ].filter(Boolean);
  if (prior) {
    parts.push(
      'Your previous attempt FAILED validation. Fix exactly these errors and return corrected Markdown:',
      prior.errors,
      '--- previous attempt ---',
      prior.md,
    );
  }
  return parts.join('\n');
}

// ── Deterministic, dependency-free author (default; testable, no spend) ───────

/**
 * Generates schema-valid Scenario/Course MD from a brief with no external call.
 * It is intentionally simple — the *value* here is that it always produces output
 * the Slice-1 compiler accepts, so the validation/repair/review pipeline is fully
 * exercised by tests. The real generative quality comes from `AnthropicAuthor`.
 */
export class TemplateAuthor implements Author {
  readonly name = 'template';

  async generateScenario(brief: AuthoringBrief, _opts?: AuthorOptions): Promise<string> {
    return renderScenarioMd(brief);
  }

  async generateCourse(brief: AuthoringBrief, _opts?: AuthorOptions): Promise<GeneratedCourse> {
    const count = Math.max(1, Math.min(8, brief.scenarioCount ?? 3));
    const courseSlug = slugify(brief.topic);
    const scenarioMds: string[] = [];
    const memberSlugs: string[] = [];
    for (let i = 1; i <= count; i++) {
      const part = `${brief.topic} — part ${i}`;
      const slug = `${courseSlug}-${i}`;
      memberSlugs.push(slug);
      scenarioMds.push(renderScenarioMd({ ...brief, topic: part }, slug, `${titleCase(brief.topic)} — Part ${i}`));
    }
    const courseMd = renderCourseMd(brief, courseSlug, memberSlugs);
    return { courseMd, scenarioMds };
  }
}

function renderScenarioMd(brief: AuthoringBrief, slugOverride?: string, nameOverride?: string): string {
  const slug = slugOverride ?? slugify(brief.topic);
  const name = nameOverride ?? titleCase(brief.topic);
  const topic = brief.topic.replace(/\n/g, ' ').trim();
  const role = brief.role ?? 'General';
  const difficulty = brief.difficulty ?? 'intermediate';
  // gray-matter/YAML: keep values simple; persona is a block scalar.
  return `---
id: ${slug}
name: ${escapeYaml(name)}
description: ${escapeYaml(`Practice scenario: ${topic}.`)}
persona: |
  You are a realistic counterpart in a "${topic}" role-play. Stay fully in
  character and never break the fourth wall. Be specific, raise plausible
  objections, and respond to what the learner actually says. Adapt difficulty to
  the learner; do not lecture.
rubric:
  - topic: Preparation & Framing
    weight: 30
    note: Did the learner set context and goals before diving in?
  - topic: Core Skill
    weight: 40
    note: Did the learner demonstrate the central skill for "${topic}"?
  - topic: Communication
    weight: 30
    note: Clarity, listening, and tone throughout.
voice:
  name: alloy
  language: en-US
visibility: ${brief.visibility ?? 'private'}
metadata:
  role: ${escapeYaml(role)}
  difficulty: ${escapeYaml(difficulty)}
  authored_by: ai
---
Reference briefing: this scenario was generated for the topic "${topic}". Surface
the rubric themes only as the conversation makes them relevant — do not volunteer
them unprompted.
`;
}

function renderCourseMd(brief: AuthoringBrief, slug: string, memberSlugs: string[]): string {
  const name = titleCase(brief.topic);
  const list = memberSlugs.map((s) => `  - ${s}`).join('\n');
  return `---
id: ${slug}
name: ${escapeYaml(name)}
description: ${escapeYaml(`An ordered course on ${brief.topic.replace(/\n/g, ' ').trim()}.`)}
scenarios:
${list}
visibility: ${brief.visibility ?? 'private'}
metadata:
  role: ${escapeYaml(brief.role ?? 'General')}
  authored_by: ai
---
A multi-part course that builds skill in "${brief.topic.replace(/\n/g, ' ').trim()}"
across ${memberSlugs.length} ordered scenarios.
`;
}

/** Minimal YAML-safe inline scalar (quote if it contains risky chars). */
function escapeYaml(value: string): string {
  const v = value.replace(/\n/g, ' ').trim();
  if (/[:#\-?{}\[\],&*!|>'"%@`]/.test(v) || v === '') {
    return `"${v.replace(/"/g, '\\"')}"`;
  }
  return v;
}

/**
 * Resolve the active author. Default = deterministic template (tested, no spend).
 * `AUTHORING_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` selects the live Claude
 * author; this factory mirrors `getProvider` (voice) and `getScorer` (analyst).
 */
export function getAuthor(): Author {
  if (process.env.AUTHORING_PROVIDER === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    // Lazy require keeps the live adapter (and its circular import on this module)
    // out of the default/test path entirely.
    const { AnthropicAuthor } = require('./adapters/anthropic') as typeof import('./adapters/anthropic');
    return new AnthropicAuthor();
  }
  return new TemplateAuthor();
}
