/**
 * Analyst — the rubric-scoring worker (Slice 2).
 *
 * `analyzeSession` is the worker entry point: load a COMPLETED session + its
 * scenario, score the transcript against the scenario `rubric`, and upsert the
 * `analysis` projection. It is idempotent (re-running re-scores the same session)
 * so it is safe to drive from a queue, a cron, or a synchronous "Analyze" click.
 *
 * Scoring is behind a `Scorer` seam — the SAME swap-ability pattern as the
 * realtime voice vendors (ADR-003). The default `HeuristicScorer` is deterministic
 * and dependency-free so the Analyst is fully testable offline with no spend; the
 * production LLM-judge implements the identical interface and is selected when a
 * key is configured (see `getScorer`). Keeping the seam means the report shape,
 * persistence, and History/Analytics wiring are all exercised by tests today, and
 * swapping in the judge touches one file (follow-up: live LLM-judge integration).
 */
import type { ScenarioRecord, RubricItem } from '@/domain/scenario';
import { parseRubricText } from '@/authoring/author';
import type {
  AnalysisRecord, Evaluation, Improvement, ReportCardItem,
} from '@/domain/analysis';
import type { SessionRecord, SessionTranscript, Store } from '@/db/store';

export class AnalystError extends Error {}

/** What a scorer produces (the persisted analysis minus bookkeeping columns). */
export interface ScoreResult {
  overallScore: number;
  evaluation: Evaluation;
  improvement: Improvement;
}

/** The scoring seam. A production LLM-judge implements the same interface. */
export interface Scorer {
  readonly name: string; // 'heuristic' | 'llm:<model>'
  score(scenario: ScenarioRecord, transcript: SessionTranscript): Promise<ScoreResult>;
}

const PASS_MARK = 70; // ≥ → strength; < → weakness / improvement area
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'your', 'you', 'are', 'was', 'has', 'had', 'how',
  'why', 'who', 'what', 'when', 'this', 'that', 'their', 'them', 'about', 'into',
  'a', 'an', 'of', 'to', 'in', 'on', 'is', 'it', 'be', 'or', 'as', 'at', 'by',
]);

function keywords(...parts: string[]): string[] {
  const words = parts
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * The rubric to score against (SAU-238). Prefer the structured rubric the author
 * already processed; otherwise generate it from the free-text rubric saved in
 * `metadata._rubricText` — "the Processed rubrik is generated on first session
 * analysis". This is the deterministic parse (no spend); the author can still
 * Process with the live AI in the Studio beforehand.
 */
function resolveRubric(scenario: ScenarioRecord): RubricItem[] {
  if (scenario.rubric?.length) return scenario.rubric;
  const raw = scenario.metadata?._rubricText;
  if (typeof raw === 'string' && raw.trim()) return parseRubricText(raw);
  return [];
}

/**
 * Deterministic, dependency-free scorer. Scores each rubric topic by how well the
 * learner's turns engaged its keywords (topic + note words), giving partial credit
 * so participation is never zero, then weights into a final score. Honest as an
 * MVP read-model and — critically — fully testable; the LLM-judge is the prod swap.
 */
export class HeuristicScorer implements Scorer {
  readonly name = 'heuristic';

  async score(scenario: ScenarioRecord, transcript: SessionTranscript): Promise<ScoreResult> {
    const learnerText = transcript.turns
      .filter((t) => t.role === 'user')
      .map((t) => t.text)
      .join(' ')
      .toLowerCase();
    const learnerWords = new Set(keywords(learnerText));
    const userTurns = transcript.turns.filter((t) => t.role === 'user').length;

    // Participation floor: engagement when a topic has no matchable keywords.
    const participation = clampScore(50 + userTurns * 8);

    const rubric = resolveRubric(scenario);
    const reportCard: ReportCardItem[] = rubric.map((item) => {
      const kw = keywords(item.topic, item.note ?? '');
      let score: number;
      if (kw.length === 0) {
        score = participation;
      } else {
        const matched = kw.filter((w) => learnerWords.has(w)).length;
        const coverage = matched / kw.length;
        // 40 base for showing up + up to 60 for topic coverage.
        score = clampScore(40 + 60 * coverage);
      }
      return { topic: item.topic, score, weight: item.weight, note: item.note };
    });

    let finalScore: number;
    if (reportCard.length === 0) {
      finalScore = participation;
    } else {
      const totalWeight = reportCard.reduce((s, r) => s + (r.weight || 0), 0);
      finalScore = totalWeight > 0
        ? clampScore(reportCard.reduce((s, r) => s + r.score * (r.weight || 0), 0) / totalWeight)
        : clampScore(reportCard.reduce((s, r) => s + r.score, 0) / reportCard.length);
    }

    const strengths = reportCard.filter((r) => r.score >= PASS_MARK).map((r) => r.topic);
    const weaknesses = reportCard.filter((r) => r.score < PASS_MARK).map((r) => r.topic);
    const actionItems = weaknesses.map(
      (topic) => `Practice "${topic}" — engage it more directly and with specifics next time.`,
    );
    if (reportCard.length === 0) {
      actionItems.push('Add a rubric to this scenario to get topic-level scoring.');
    }

    return {
      overallScore: finalScore,
      evaluation: { reportCard, finalScore, strengths, weaknesses },
      improvement: { areas: weaknesses, actionItems },
    };
  }
}

/**
 * Resolve the active scorer. Default = deterministic heuristic (tested, no spend).
 * The production LLM-judge implements `Scorer` and is selected via env once wired;
 * keeping this factory mirrors `getProvider` in the voice seam.
 */
export function getScorer(): Scorer {
  // ANALYST_SCORER=llm + OPENAI_API_KEY would select the judge (follow-up).
  return new HeuristicScorer();
}

/**
 * Worker: score a completed session and persist the `analysis` projection.
 * Idempotent — re-running re-scores and upserts the same session's analysis.
 */
export async function analyzeSession(
  store: Store,
  sessionId: string,
  scorer: Scorer = getScorer(),
): Promise<AnalysisRecord> {
  const session = await store.getSession(sessionId);
  if (!session) throw new AnalystError(`session ${sessionId} not found`);
  if (session.status !== 'completed') {
    throw new AnalystError(`session ${sessionId} is ${session.status}; only completed sessions can be analyzed`);
  }
  const transcript: SessionTranscript = session.transcript ?? { turns: [], toolCalls: [] };
  const scenario = await store.getScenarioById(session.scenarioId);
  if (!scenario) throw new AnalystError(`scenario ${session.scenarioId} not found for session ${sessionId}`);

  const result = await scorer.score(scenario, transcript);
  return store.upsertAnalysis({
    sessionId: session.id,
    scenarioId: session.scenarioId,
    userId: session.userId,
    scorer: scorer.name,
    overallScore: result.overallScore,
    evaluation: result.evaluation,
    improvement: result.improvement,
  });
}

export type { SessionRecord };
