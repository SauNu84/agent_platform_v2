/**
 * Persistence contract for Slice 1.
 *
 * The whole platform talks to this interface; the Postgres implementation is the
 * production artifact (db/migrations/0001), and the in-memory implementation lets
 * the compiler/CRUD/voice logic be tested hermetically (no live Postgres in CI).
 * Same pattern the realtime seam uses for vendors: one interface, swappable impls.
 */
import type { CompiledScenarioRecord, RubricItem, ScenarioRecord } from '@/domain/scenario';
import type { ToolDefinition, SessionUsage } from '@/voice/realtime-interface';
import type { CoachRecord, CompiledCoachRecord } from '@/domain/coach';
import type { CourseRecord, CompiledCourseRecord } from '@/domain/course';

export type ContentEntityType = 'scenario' | 'coach' | 'course';

export interface ContentSourceRecord {
  entityType: ContentEntityType;
  entityId: string;
  repoPath: string;
  contentHash: string;
  revision: string | null;
  compiledAt: string;
}

/** The compile-source tuple persisted alongside every compiled row (ADR-002). */
export interface ContentSourceInput {
  repoPath: string;
  contentHash: string;
  revision: string | null;
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
  /** set when the session was started from a Coach (Slice 3) */
  coachId?: string | null;
  /** set when the session was started inside a Course (Slice 3) */
  courseId?: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string | null;
  scenarioId: string;
  coachId: string | null;
  courseId: string | null;
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

// ── Coach memory (ADR-004) ─────────────────────────────────────────────────
export type MemoryKind = 'summary' | 'fact' | 'preference' | 'goal';

export interface NewCoachMemory {
  coachId: string;
  userId: string;
  kind: MemoryKind;
  content: string;            // DERIVED text — never a raw transcript (ADR-004)
  embedding: number[];        // pgvector embedding of `content`
  sourceSessionId: string | null;
  salience: number;
  expiresAt: string;          // ISO — set at write time (ADR-004 retention)
}

export interface CoachMemoryRecord extends NewCoachMemory {
  id: string;
  createdAt: string;
}

// ── Record-of-consent (ADR-004 §User controls; append-only) ─────────────────
export type ConsentType = 'persistent_memory' | 'audio_retention';

export interface NewConsent {
  userId: string;
  scope: string;              // 'coach:<id>' | 'global'
  consentType: ConsentType;
  action: 'granted' | 'revoked';
  policyVersion?: string | null;
  policyTextHash?: string | null;
  locale?: string | null;
  uiSurface?: string | null;
}

export interface ConsentRecord extends NewConsent {
  id: string;
  createdAt: string;
}

/** Current consent state for a (user, scope), reconstructed from the append log. */
export interface ConsentState {
  persistentMemory: boolean;
  audioRetention: boolean;
}

// ── Audit log (ADR-004 §audit logging; append-only, PII-free) ───────────────
export interface AuditEvent {
  actor: string;              // 'user:<id>' | 'system' | 'staff:<id>'
  event: string;              // memory.write | memory.retrieve | memory.delete | consent.grant | ...
  subjectUserId: string | null;
  coachId: string | null;
  refs: Record<string, unknown>;   // counts/ids only — NO PII content
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
  getContentSource(entityType: ContentEntityType, entityId: string): Promise<ContentSourceRecord | null>;

  // ── Coach CRUD (Slice 3 — composition over Scenario) ────────────────────────
  listCoaches(): Promise<CoachRecord[]>;
  getCoachBySlug(slug: string): Promise<CoachRecord | null>;
  getCoachById(id: string): Promise<CoachRecord | null>;
  deleteCoach(slug: string): Promise<boolean>;
  /** Transactional compile-upsert: resolve scenarioRef→id, upsert coach + content_source. */
  upsertCoachFromCompile(
    rec: CompiledCoachRecord,
    source: ContentSourceInput,
  ): Promise<{ coach: CoachRecord; source: ContentSourceRecord; created: boolean }>;

  // ── Course CRUD (Slice 3 — ordered Scenario refs + optional coach) ──────────
  listCourses(): Promise<CourseRecord[]>;
  getCourseBySlug(slug: string): Promise<CourseRecord | null>;
  getCourseById(id: string): Promise<CourseRecord | null>;
  deleteCourse(slug: string): Promise<boolean>;
  /** Resolve coachRef + ordered scenarioRefs, upsert course + course_scenario + content_source. */
  upsertCourseFromCompile(
    rec: CompiledCourseRecord,
    source: ContentSourceInput,
  ): Promise<{ course: CourseRecord; source: ContentSourceRecord; created: boolean }>;

  // ── Sessions ─────────────────────────────────────────────────────────────────
  createSession(input: NewSession): Promise<SessionRecord>;
  appendSessionEvent(row: SessionEventRow): Promise<void>;
  completeSession(
    sessionId: string,
    update: { status: 'completed' | 'failed'; endedAt: number; transcript: SessionTranscript },
  ): Promise<SessionRecord | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessionsByScenario(scenarioId: string): Promise<SessionRecord[]>;
  listSessionsByCourse(courseId: string): Promise<SessionRecord[]>;
  listSessionsByCoachUser(coachId: string, userId: string): Promise<SessionRecord[]>;
  listSessionEvents(sessionId: string): Promise<SessionEventRow[]>;

  // ── Voice usage metering ──────────────────────────────────────────────────────
  recordVoiceUsage(usage: VoiceUsageRecord): Promise<void>;
  getVoiceUsage(sessionId: string): Promise<VoiceUsageRecord | null>;

  // ── Coach memory (ADR-004): per-(coach,user), RLS-scoped in Postgres ────────
  writeCoachMemory(rec: NewCoachMemory): Promise<CoachMemoryRecord>;
  /** All non-expired memories for (coach,user), recency desc. Ranking is app-layer. */
  listCoachMemory(coachId: string, userId: string): Promise<CoachMemoryRecord[]>;
  /** Bump expires_at on retrieval/reinforcement (ADR-004 dormancy backstop). */
  bumpCoachMemoryExpiry(ids: string[], userId: string, expiresAt: string): Promise<void>;
  /** Right-to-erasure: delete one memory (returns true if it existed). */
  deleteCoachMemory(coachId: string, userId: string, memoryId: string): Promise<boolean>;
  /** Wipe all memory for (coach,user); returns count purged (cascades embeddings). */
  wipeCoachMemory(coachId: string, userId: string): Promise<number>;

  // ── Consent + audit (ADR-004) ───────────────────────────────────────────────
  recordConsent(rec: NewConsent): Promise<ConsentRecord>;
  getConsentState(userId: string, scope: string): Promise<ConsentState>;
  listConsent(userId: string, scope: string): Promise<ConsentRecord[]>;
  recordAuditEvent(ev: AuditEvent): Promise<void>;
  listAuditEvents(subjectUserId: string): Promise<(AuditEvent & { ts: string })[]>;
}

// Re-export commonly used domain types for store consumers.
export type { ScenarioRecord, CompiledScenarioRecord, RubricItem, ToolDefinition, SessionUsage };
export type { CoachRecord, CompiledCoachRecord, CourseRecord, CompiledCourseRecord };
