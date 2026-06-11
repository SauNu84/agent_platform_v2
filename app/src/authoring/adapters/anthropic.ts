/**
 * Anthropic (Claude) authoring adapter (LIVE) — one file = one provider behind
 * the `Author` seam, mirroring the realtime voice adapters.
 *
 * Transport: raw HTTPS to the Messages API (the repo's vendor convention — see
 * voice/adapters/openai.ts — keeps the dependency surface minimal; no SDK).
 * Auth: `ANTHROPIC_API_KEY`. Model: `claude-opus-4-8` (the most capable Claude;
 * override via `AUTHORING_MODEL`). Adaptive thinking is on so generation reasons
 * about the schema before emitting.
 *
 * The model returns Markdown only; this adapter strips an accidental code fence
 * and otherwise does NOT mutate the output — the Slice-1 compiler is the gate
 * (pipeline.ts), so a malformed generation is rejected with actionable errors
 * and fed back here for a repair turn rather than silently "fixed".
 */
import matter from 'gray-matter';
import {
  Author, AuthoringBrief, AuthorOptions, GeneratedCourse,
  authoringSystemPrompt, scenarioUserPrompt, COURSE_SCHEMA_CONTRACT,
  rubricParseSystemPrompt, rubricParseUserPrompt, roundWeightsTo100, parseRubricText,
} from '../author';
import type { RubricItem } from '@/domain/scenario';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.AUTHORING_MODEL || 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicAuthor implements Author {
  readonly name = `anthropic:${MODEL}`;

  async generateScenario(brief: AuthoringBrief, opts?: AuthorOptions): Promise<string> {
    const text = await this.complete(authoringSystemPrompt(), scenarioUserPrompt(brief, opts?.prior));
    return stripFence(text);
  }

  async generateCourse(brief: AuthoringBrief, opts?: AuthorOptions): Promise<GeneratedCourse> {
    const count = Math.max(1, Math.min(8, brief.scenarioCount ?? 3));
    // Generate the member scenarios first so we can hand the course their REAL
    // ids — guaranteeing the course's references resolve (the compiler enforces it).
    const scenarioMds: string[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) {
      const md = await this.generateScenario(
        { ...brief, topic: `${brief.topic} (part ${i} of ${count})` },
        i === 1 ? opts : undefined,
      );
      scenarioMds.push(md);
      ids.push(idOf(md, i));
    }
    const courseMd = stripFence(await this.complete(
      authoringSystemPrompt() + '\n\n' + COURSE_SCHEMA_CONTRACT,
      [
        `Write ONE Course titled around: ${brief.topic}`,
        `It MUST list exactly these scenario ids, in this order: ${ids.join(', ')}`,
        `Visibility: ${brief.visibility ?? 'private'}`,
      ].join('\n'),
    ));
    return { courseMd, scenarioMds };
  }

  async parseRubric(text: string): Promise<RubricItem[]> {
    const raw = stripFence(await this.complete(rubricParseSystemPrompt(), rubricParseUserPrompt(text)));
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      // Model didn't return clean JSON — fall back to the deterministic parser
      // rather than failing the author's request.
      return parseRubricText(text);
    }
    if (!Array.isArray(arr)) return parseRubricText(text);
    // Coerce/clean each entry, then re-normalize weights to sum to 100 (the model
    // is asked to do this, but we never trust it to be exact).
    const items = arr
      .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : null))
      .filter((e): e is Record<string, unknown> => !!e && typeof e.topic === 'string' && (e.topic as string).trim().length > 0)
      .map((e) => ({
        topic: (e.topic as string).trim(),
        weight: Number.isFinite(Number(e.weight)) ? Number(e.weight) : 0,
        note: typeof e.note === 'string' && e.note.trim() ? e.note.trim() : undefined,
      }));
    if (items.length === 0) return parseRubricText(text);
    const weights = roundWeightsTo100(items.map((i) => i.weight));
    return items.map((i, idx) => ({ topic: i.topic, weight: weights[idx], ...(i.note ? { note: i.note } : {}) }));
  }

  /** One Messages API round-trip → the concatenated text content. */
  private async complete(system: string, user: string): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY not set — live AI authoring is BLOCKED on credential provisioning. ' +
        'The default TemplateAuthor runs the pipeline offline with no spend.',
      );
    }
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic Messages API ${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
      .trim();
    if (!text) throw new Error('Anthropic Messages API returned no text content');
    return text;
  }
}

/** Strip a leading/trailing ```markdown / ``` fence the model may add. */
function stripFence(text: string): string {
  const fence = /^```(?:markdown|md|yaml)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = text.trim().match(fence);
  return (m ? m[1] : text).trim() + '\n';
}

/** Best-effort scenario id from generated MD (fallback keeps the course valid). */
function idOf(md: string, i: number): string {
  try {
    const data = matter(md).data as { id?: string; slug?: string };
    const id = data.id ?? data.slug;
    if (typeof id === 'string' && id) return id;
  } catch {
    /* fall through */
  }
  return `scenario-${i}`;
}
