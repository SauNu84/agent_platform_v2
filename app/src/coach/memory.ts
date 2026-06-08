/**
 * Coach memory subsystem (ADR-004).
 *
 * This is the feature that differentiates a Coach from a one-off Scenario: it
 * "remembers every conversation" per-user-per-coach. We store DERIVED summaries
 * and facts (never raw transcripts; ADR-004 §Storage), embed them for semantic
 * retrieval, and on the next session retrieve the most relevant memories and
 * inject them into the agent's instructions — so the coach demonstrably picks up
 * where the learner left off.
 *
 * The embedder here is a deterministic, dependency-free local model (token-hash
 * into a fixed-dim unit vector). It keeps retrieval testable and the MVP free of
 * an external embedding API; the `vector(1536)` column and pgvector ANN index are
 * already in place (migration 0003) for swapping in a real embedding model later
 * behind this same `embed()` seam.
 */
import type { CoachMemoryRecord, MemoryKind, NewCoachMemory, SessionTranscript } from '@/db/store';

export const EMBED_DIM = 1536;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'i', 'you', 'we', 'it', 'this', 'that', 'with', 'as', 'at', 'by',
  'my', 'me', 'your', 'our', 'so', 'do', 'did', 'has', 'have', 'had', 'will', 'would',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Stable 32-bit string hash (FNV-1a) — deterministic across runs/processes. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic local embedding: token-hash bag-of-words → L2-normalized vector. */
export function embed(text: string, dim = EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of tokenize(text)) {
    const h = fnv1a(tok);
    const idx = h % dim;
    const sign = (h & 1) === 0 ? 1 : -1; // signed hashing reduces collisions
    v[idx] += sign;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are unit vectors
}

// ── Retention windows (ADR-004 §Retention) ───────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_RETENTION_MS = 365 * DAY_MS;       // summaries: 365d rolling
const FACT_RETENTION_MS = 730 * DAY_MS;          // facts/prefs/goals: 24-month dormancy

export function expiresAtFor(kind: MemoryKind, fromMs: number): string {
  const ms = kind === 'summary' ? SUMMARY_RETENTION_MS : FACT_RETENTION_MS;
  return new Date(fromMs + ms).toISOString();
}

// ── Derivation: transcript → derived memories (never raw transcript) ─────────
export interface DerivedMemory {
  kind: MemoryKind;
  content: string;
  salience: number;
}

const FIRST_PERSON = /\b(i am|i'm|i was|i have|i've|my name is|i prefer|i like|i want|i need|i'm preparing|preparing for|my goal|i'm working|i struggle|i tend to)\b/i;

function classify(sentence: string): MemoryKind {
  const s = sentence.toLowerCase();
  if (/\b(prefer|like|rather|style)\b/.test(s)) return 'preference';
  if (/\b(goal|want|need|preparing|working on|aiming|trying to)\b/.test(s)) return 'goal';
  return 'fact';
}

/**
 * Derive durable memories from a completed session transcript. We synthesize one
 * rolling `summary` plus any first-person `fact`/`preference`/`goal` the learner
 * stated. This is intentionally lossy and PII-minimizing (ADR-004).
 */
export function deriveMemories(transcript: SessionTranscript, coachName: string): DerivedMemory[] {
  const out: DerivedMemory[] = [];
  const userTurns = transcript.turns.filter((t) => t.role === 'user');

  // 1) Rolling summary.
  const firstUser = userTurns[0]?.text?.trim();
  const summary = firstUser
    ? `Session with ${coachName}: ${transcript.turns.length} turns. Opened with "${truncate(firstUser, 120)}".`
    : `Session with ${coachName}: ${transcript.turns.length} turns.`;
  out.push({ kind: 'summary', content: summary, salience: 1.0 });

  // 2) First-person facts/preferences/goals.
  for (const turn of userTurns) {
    for (const sentence of splitSentences(turn.text)) {
      if (FIRST_PERSON.test(sentence)) {
        out.push({ kind: classify(sentence), content: truncate(sentence.trim(), 200), salience: 1.5 });
      }
    }
  }
  return dedupe(out);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function dedupe(mems: DerivedMemory[]): DerivedMemory[] {
  const seen = new Set<string>();
  const out: DerivedMemory[] = [];
  for (const m of mems) {
    const key = `${m.kind}:${m.content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// ── Retrieval: rank candidates by hybrid recency + similarity + salience ─────
export interface RetrieveOptions {
  /** optional query text; when present, semantic similarity is weighted in */
  query?: string;
  /** how many memories to inject (token-budget bound; ADR-004) */
  k?: number;
  /** "now" in ms (injectable for deterministic tests) */
  nowMs?: number;
}

const RECENCY_HALFLIFE_DAYS = 30;

export function rankMemories(candidates: CoachMemoryRecord[], opts: RetrieveOptions = {}): CoachMemoryRecord[] {
  const now = opts.nowMs ?? Date.now();
  const k = opts.k ?? 8;
  const qEmb = opts.query ? embed(opts.query) : null;
  const maxSalience = Math.max(1, ...candidates.map((c) => c.salience));

  const scored = candidates.map((m) => {
    const ageDays = Math.max(0, (now - Date.parse(m.createdAt)) / DAY_MS);
    const recency = Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
    const salienceNorm = m.salience / maxSalience;
    const sim = qEmb ? Math.max(0, cosine(qEmb, m.embedding)) : 0;
    const score = qEmb
      ? 0.5 * sim + 0.3 * recency + 0.2 * salienceNorm
      : 0.6 * recency + 0.4 * salienceNorm;
    return { m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.m);
}

/**
 * Build the "what you remember" block injected into the agent's instructions.
 * Returns null when there's nothing to inject (so a first-ever session is clean).
 */
export function buildMemoryBlock(memories: CoachMemoryRecord[]): string | null {
  if (!memories.length) return null;
  const lines = memories.map((m) => `- (${m.kind}) ${m.content}`);
  return [
    '## What you remember about this learner',
    'You have coached this learner before. Draw on these remembered details naturally to pick up where you left off — do not read them aloud verbatim.',
    ...lines,
  ].join('\n');
}
