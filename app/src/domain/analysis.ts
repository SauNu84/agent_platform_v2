/**
 * Analyst domain model — the rubric-scored projection over a completed session.
 *
 * `analysis` is a read-model over `session` (ERD / ADR-001): the Analyst worker
 * scores the transcript against the scenario `rubric` and produces an evaluation
 * (report card + final score + strengths/weaknesses) plus an improvement plan.
 * The grouped `evaluation` / `improvement` shape mirrors the reference API; the
 * `analysis` table stores the same data as flat columns (see migration 0002).
 */
import type { RubricItem } from './scenario';

/** One scored rubric topic. `weight` carries through from the scenario rubric. */
export interface ReportCardItem {
  topic: string;
  score: number;   // 0–100
  weight: number;  // from the rubric (relative)
  note?: string;
}

export interface Evaluation {
  reportCard: ReportCardItem[];
  finalScore: number;   // 0–100, weighted across reportCard
  strengths: string[];
  weaknesses: string[];
}

export interface Improvement {
  areas: string[];        // topics to focus on
  actionItems: string[];  // concrete next steps
}

/** Canonical analysis record (camelCase projection of the `analysis` row). */
export interface AnalysisRecord {
  sessionId: string;
  scenarioId: string;
  userId: string | null;
  scorer: string;          // 'heuristic' | 'llm:<model>'
  overallScore: number;
  evaluation: Evaluation;
  improvement: Improvement;
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
}

/** Re-export the rubric type so Analyst consumers have one import surface. */
export type { RubricItem };
