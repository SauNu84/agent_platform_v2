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
import { TOOL_REGISTRY, type RubricItem } from '@/domain/scenario';

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
  /**
   * Parse a free-text rubric the author wrote in the "Edit" tab into the
   * structured, schema-shaped rubric the platform scores against (SAU-238). The
   * raw text stays human-readable; this is the "Processed" projection an LLM (or
   * the deterministic fallback) turns into `{ topic, weight, note }[]` with
   * weights summing to 100. The structured result is still review-gated — the
   * author confirms it before it is saved.
   */
  parseRubric(text: string): Promise<RubricItem[]>;
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

// ── Rubric parsing (SAU-238): free text → structured { topic, weight, note }[] ─

/** System prompt for the live rubric parser. */
export function rubricParseSystemPrompt(): string {
  return [
    'You convert a coach\'s free-text grading rubric into a structured rubric for an automated LLM judge.',
    'Return ONLY a JSON array (no prose, no code fence) of objects with these keys:',
    '  topic:  short criterion name (string, required)',
    '  weight: integer 0-100, importance of this criterion (the weights MUST sum to 100)',
    '  note:   optional one-line clarification of what good looks like (string)',
    'Infer sensible weights from the author\'s emphasis and ordering. If the author gave no weights, distribute 100 evenly.',
    'Keep the author\'s wording; do not invent criteria they did not mention.',
  ].join('\n');
}

/** User prompt carrying the author's free text. */
export function rubricParseUserPrompt(text: string): string {
  return `Parse this rubric into the JSON array described above:\n\n${text.trim()}`;
}

/**
 * Round a set of fractional weights to integers that sum to exactly 100, giving
 * any rounding remainder to the largest entries (largest-remainder method).
 * Returns an empty array unchanged.
 */
export function roundWeightsTo100(weights: number[]): number[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) {
    // No signal — distribute 100 as evenly as possible.
    const base = Math.floor(100 / weights.length);
    const out = weights.map(() => base);
    for (let i = 0; i < 100 - base * weights.length; i++) out[i] += 1;
    return out;
  }
  const scaled = weights.map((w) => (w / total) * 100);
  const floored = scaled.map(Math.floor);
  let remainder = 100 - floored.reduce((s, w) => s + w, 0);
  // Hand the leftover points to the entries with the largest fractional parts.
  const order = scaled
    .map((w, i) => ({ i, frac: w - Math.floor(w) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) floored[order[k].i] += 1;
  return floored;
}

/**
 * Deterministic, dependency-free rubric parser — the no-spend fallback behind
 * the same seam as `TemplateAuthor`. Splits the text into criteria (one per line
 * or `;`-separated), pulls an explicit `NN%` / `weight: NN` if present, treats a
 * trailing `:`/`—`/`-` separated clause as the note, and normalizes weights to
 * sum to 100 (explicit weights honored; unspecified ones share the remainder).
 */
export function parseRubricText(text: string): RubricItem[] {
  const segments = text
    .split(/\r?\n|;/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()) // strip bullets/numbering
    .filter((s) => s.length > 0);

  const parsed = segments.map((seg) => {
    let rest = seg;
    let weight: number | null = null;
    // Explicit weight: "30%", "weight: 30", "weight 30".
    const pct = rest.match(/(\d{1,3})\s*%/);
    const labeled = rest.match(/\bweight\s*[:=]?\s*(\d{1,3})\b/i);
    if (pct) { weight = clampPct(Number(pct[1])); rest = rest.replace(pct[0], '').trim(); }
    else if (labeled) { weight = clampPct(Number(labeled[1])); rest = rest.replace(labeled[0], '').trim(); }
    // Tidy separators/punctuation left behind by weight removal.
    rest = rest.replace(/[\s:;,(){}\[\]]*[—–-]?[\s:;]*$/, '').replace(/^[\s,—–-]+/, '').trim();
    // Split a trailing note off the topic on the first ':' / '—' / ' - '.
    let topic = rest;
    let note: string | undefined;
    const sep = rest.match(/\s*(?::|—|–|\s-\s)\s*/);
    if (sep && sep.index !== undefined && sep.index > 0) {
      topic = rest.slice(0, sep.index).trim();
      const tail = rest.slice(sep.index + sep[0].length).replace(/[\s:;,–—-]+$/, '').trim();
      if (tail) note = tail;
    }
    return { topic: topic || seg.trim(), note, weight };
  });

  const weights = roundWeightsTo100(distributeWeights(parsed.map((p) => p.weight)));
  return parsed.map((p, i) => ({
    topic: p.topic,
    weight: weights[i],
    ...(p.note ? { note: p.note } : {}),
  }));
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Turn a mix of explicit and `null` weights into concrete numbers: explicit
 * weights are kept, and the rest share whatever of 100 is left (evenly). If
 * nothing was explicit, everything is 0 here and `roundWeightsTo100` spreads 100.
 */
function distributeWeights(weights: Array<number | null>): number[] {
  const explicitTotal = weights.reduce<number>((s, w) => s + (w ?? 0), 0);
  const blanks = weights.filter((w) => w === null).length;
  const share = blanks > 0 ? Math.max(0, 100 - explicitTotal) / blanks : 0;
  return weights.map((w) => (w === null ? share : w));
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

  async parseRubric(text: string): Promise<RubricItem[]> {
    return parseRubricText(text);
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
