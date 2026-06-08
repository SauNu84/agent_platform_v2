/**
 * Persistence contract for Slice 1.
 *
 * The whole platform talks to this interface; the Postgres implementation is the
 * production artifact (db/migrations/0001), and the in-memory implementation lets
 * the compiler/CRUD/voice logic be tested hermetically (no live Postgres in CI).
 * Same pattern the realtime seam uses for vendors: one interface, swappable impls.
 */
import type { CompiledScenarioRecord, RubricItem, ScenarioRecord } from '@/domain/scenario';
import type { AnalysisRecord, Evaluation, Improvement } from '@/domain/analysis';
import type { ToolDefinition, SessionUsage } from '@/voice/realtime-interface';

export interface ContentSourceRecord {
  entityType: 'scenario' | 'coach' | 'course';
  entityId: string;
  repoPath: string;
  contentHash: string;
  revision: string | null;
  compiledAt: string;
}

export interface ScenarioFilter {
  isPublic?: boolean;
  /** metadata key/value pairs that must all match (Library filter) */
  metadata?: Record<string, unknown>;
}

export interface NewSession {
  scenarioId: string;
  userId?: string | null;
  vendor: string;
}

export interface SessionRecord {
  id: string;
  userId: string | null;
  scenarioId: string;
  vendor: string;
  status: 'active' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  transcript: SessionTranscript | null;
}

export interface SessionTranscript {
  turns: Array<{ role: 'user' | 'agent'; text: string; at: number }>;
  toolCalls: Array<{ name: string; args: unknown; result: unknown; at: number }>;
}

export interface SessionEventRow {
  sessionId: string;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface VoiceUsageRecord {
  sessionId: string;
  userId: string | null;
  scenarioId: string;
  vendor: string;
  model: string | null;
  durationMs: number;
  voiceMinutes: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  cachedTextTokens: number;
  cachedAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  totalTokens: number;
}

/** Input to upsertAnalysis — the record minus DB-assigned timestamps. */
export interface NewAnalysis {
  sessionId: string;
  scenarioId: string;
  userId: string | null;
  scorer: string;
  overallScore: number;
  evaluation: Evaluation;
  improvement: Improvement;
}

/** Per-user activity row (projection over session + analysis; ERD session_history). */
export interface SessionHistoryRow {
  sessionId: string;
  scenarioId: string;
  scenarioSlug: string;
  scenarioName: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  status: 'active' | 'completed' | 'failed';
  analyzed: boolean;
  finalScore: number | null;
}

/** Per-scenario aggregate row for Creator Analytics. */
export interface CreatorAnalyticsRow {
  scenarioId: string;
  slug: string;
  name: string;
  sessions: number;
  avgDurationMs: number;
  totalVoiceMinutes: number;
}

/** Per-user voice-minute entitlement (plan + caps). */
export interface EntitlementRecord {
  userId: string;
  plan: 'free' | 'paid';
  freeMinutes: number;
  paidMinutes: number;
}

export interface Store {
  // ── Scenario CRUD ──────────────────────────────────────────────────────────
  listScenarios(filter?: ScenarioFilter): Promise<ScenarioRecord[]>;
  getScenarioBySlug(slug: string): Promise<ScenarioRecord | null>;
  getScenarioById(id: string): Promise<ScenarioRecord | null>;
  createScenario(rec: CompiledScenarioRecord): Promise<ScenarioRecord>;
  updateScenario(slug: string, patch: Partial<CompiledScenarioRecord>): Promise<ScenarioRecord | null>;
  deleteScenario(slug: string): Promise<boolean>;

  /** Transactional compile-upsert: upsert the scenario row + its content_source. */
  upsertScenarioFromCompile(
    rec: CompiledScenarioRecord,
    source: { repoPath: string; contentHash: string; revision: string | null },
  ): Promise<{ scenario: ScenarioRecord; source: ContentSourceRecord; created: boolean }>;
  getContentSource(entityType: 'scenario' | 'coach' | 'course', entityId: string): Promise<ContentSourceRecord | null>;

  // ── Sessions ─────────────────────────────────────────────────────────────────
  createSession(input: NewSession): Promise<SessionRecord>;
  appendSessionEvent(row: SessionEventRow): Promise<void>;
  completeSession(
    sessionId: string,
    update: { status: 'completed' | 'failed'; startedAt?: number; endedAt: number; transcript: SessionTranscript },
  ): Promise<SessionRecord | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessionsByScenario(scenarioId: string): Promise<SessionRecord[]>;
  listSessionEvents(sessionId: string): Promise<SessionEventRow[]>;

  // ── Voice usage metering ──────────────────────────────────────────────────────
  recordVoiceUsage(usage: VoiceUsageRecord): Promise<void>;
  getVoiceUsage(sessionId: string): Promise<VoiceUsageRecord | null>;

  // ── Slice 2: Analyst projection ───────────────────────────────────────────────
  upsertAnalysis(rec: NewAnalysis): Promise<AnalysisRecord>;
  getAnalysis(sessionId: string): Promise<AnalysisRecord | null>;

  // ── Slice 2: History (read-model) + Creator analytics ─────────────────────────
  listSessionHistory(userId: string): Promise<SessionHistoryRow[]>;
  getCreatorAnalytics(): Promise<CreatorAnalyticsRow[]>;

  // ── Slice 2: credit meter + entitlement ───────────────────────────────────────
  sumVoiceMinutesByUser(userId: string): Promise<number>;
  getEntitlement(userId: string): Promise<EntitlementRecord | null>;
  upsertEntitlement(rec: EntitlementRecord): Promise<EntitlementRecord>;
}

// Re-export commonly used domain types for store consumers.
export type { ScenarioRecord, CompiledScenarioRecord, RubricItem, ToolDefinition, SessionUsage };
export type { AnalysisRecord, Evaluation, Improvement };
