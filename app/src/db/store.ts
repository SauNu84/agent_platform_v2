/**
 * Persistence contract for Slice 1.
 *
 * The whole platform talks to this interface; the Postgres implementation is the
 * production artifact (db/migrations/0001), and the in-memory implementation lets
 * the compiler/CRUD/voice logic be tested hermetically (no live Postgres in CI).
 * Same pattern the realtime seam uses for vendors: one interface, swappable impls.
 */
import type { CompiledScenarioRecord, KnowledgeBaseDoc, RubricItem, ScenarioRecord } from '@/domain/scenario';
import type { AnalysisRecord, Evaluation, Improvement } from '@/domain/analysis';
import type { ToolDefinition, SessionUsage } from '@/voice/realtime-interface';
import type { CoachRecord, CompiledCoachRecord } from '@/domain/coach';
import type { CourseRecord, CompiledCourseRecord } from '@/domain/course';

export type ContentEntityType = 'scenario' | 'coach' | 'course';

// ── AuthN + RBAC (Slice 5, SAU-229 / ADR-007) ──────────────────────────────
/** A local-identity user (email + password hash). */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName: string;
  /** optional explicit id (seed reproducibility); else DB-assigned */
  id?: string;
}

/** A resolved server-side session token. */
export interface AuthSessionRecord {
  token: string;
  userId: string;
  expiresAt: string;
}

/** Owner attribution for content writes (null = platform/seeded content). */
export interface OwnerOpts {
  ownerUserId?: string | null;
}

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

/** A shareable short link mapping a URL-safe code → scenario (SAU-225). */
export interface ShareLinkRecord {
  code: string;
  scenarioId: string;
  createdAt: string;
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

// ── Knowledge Base (SAU-243, Phase 1) — reusable multi-doc corpus ────────────
export interface KnowledgeBaseRecord {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /** number of documents (convenience for list views). */
  docCount: number;
}

export interface NewKnowledgeBase {
  title: string;
  description?: string | null;
}

export type KbContentType = 'pdf' | 'docx' | 'txt';

export interface KnowledgeBaseDocRecord {
  id: string;
  kbId: string;
  filename: string;
  contentType: KbContentType;
  extractedText: string;
  chars: number;
  byteSize: number;
  createdAt: string;
}

export interface NewKnowledgeBaseDoc {
  kbId: string;
  filename: string;
  contentType: KbContentType;
  extractedText: string;
  byteSize: number;
}

export interface Store {
  // ── Scenario CRUD ──────────────────────────────────────────────────────────
  listScenarios(filter?: ScenarioFilter): Promise<ScenarioRecord[]>;
  getScenarioBySlug(slug: string): Promise<ScenarioRecord | null>;
  getScenarioById(id: string): Promise<ScenarioRecord | null>;
  createScenario(rec: CompiledScenarioRecord, owner?: OwnerOpts): Promise<ScenarioRecord>;
  updateScenario(slug: string, patch: Partial<CompiledScenarioRecord>): Promise<ScenarioRecord | null>;
  deleteScenario(slug: string): Promise<boolean>;

  /** Transactional compile-upsert: upsert the scenario row + its content_source. */
  upsertScenarioFromCompile(
    rec: CompiledScenarioRecord,
    source: { repoPath: string; contentHash: string; revision: string | null },
    owner?: OwnerOpts,
  ): Promise<{ scenario: ScenarioRecord; source: ContentSourceRecord; created: boolean }>;
  getContentSource(entityType: ContentEntityType, entityId: string): Promise<ContentSourceRecord | null>;

  // ── Knowledge Base (SAU-243) ────────────────────────────────────────────────
  createKnowledgeBase(input: NewKnowledgeBase, owner?: OwnerOpts): Promise<KnowledgeBaseRecord>;
  /** All KBs visible to the request (RLS/own-filter applied by the caller's query). */
  listKnowledgeBases(): Promise<KnowledgeBaseRecord[]>;
  getKnowledgeBase(id: string): Promise<KnowledgeBaseRecord | null>;
  deleteKnowledgeBase(id: string): Promise<boolean>;
  addKnowledgeBaseDocument(doc: NewKnowledgeBaseDoc): Promise<KnowledgeBaseDocRecord>;
  listKnowledgeBaseDocuments(kbId: string): Promise<KnowledgeBaseDocRecord[]>;
  /** Link a KB to a scenario (idempotent — re-linking is a no-op). */
  linkScenarioKnowledgeBase(scenarioId: string, kbId: string): Promise<void>;
  /** Unlink (removes the ASSOCIATION only — the KB survives). Returns true if a link existed. */
  unlinkScenarioKnowledgeBase(scenarioId: string, kbId: string): Promise<boolean>;
  listScenarioKnowledgeBases(scenarioId: string): Promise<KnowledgeBaseRecord[]>;
  /**
   * Linked-KB document text for a scenario, in deterministic INJECTION order
   * (link order, then per-KB upload order). Trusted server read used at session
   * start to fold the corpus into the system prompt — never returned to clients.
   */
  listKnowledgeForScenario(scenarioId: string): Promise<KnowledgeBaseDoc[]>;

  // ── Coach CRUD (Slice 3 — composition over Scenario) ────────────────────────
  listCoaches(): Promise<CoachRecord[]>;
  getCoachBySlug(slug: string): Promise<CoachRecord | null>;
  getCoachById(id: string): Promise<CoachRecord | null>;
  deleteCoach(slug: string): Promise<boolean>;
  /** Transactional compile-upsert: resolve scenarioRef→id, upsert coach + content_source. */
  upsertCoachFromCompile(
    rec: CompiledCoachRecord,
    source: ContentSourceInput,
    owner?: OwnerOpts,
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
    owner?: OwnerOpts,
  ): Promise<{ course: CourseRecord; source: ContentSourceRecord; created: boolean }>;

  // ── Share links (SAU-225) — short code ↔ scenario, idempotent per scenario ───
  /** Return the scenario's existing share link, or create one. Idempotent: re-calls
   *  for the same scenario return the SAME code. */
  createShareLink(scenarioId: string): Promise<ShareLinkRecord>;
  getShareLinkByCode(code: string): Promise<ShareLinkRecord | null>;

  // ── Sessions ─────────────────────────────────────────────────────────────────
  createSession(input: NewSession): Promise<SessionRecord>;
  appendSessionEvent(row: SessionEventRow): Promise<void>;
  completeSession(
    sessionId: string,
    update: { status: 'completed' | 'failed'; startedAt?: number; endedAt: number; transcript: SessionTranscript },
  ): Promise<SessionRecord | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessionsByScenario(scenarioId: string): Promise<SessionRecord[]>;
  listSessionsByCourse(courseId: string): Promise<SessionRecord[]>;
  listSessionsByCoachUser(coachId: string, userId: string): Promise<SessionRecord[]>;
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

  // ── AuthN + RBAC (Slice 5, SAU-229) ─────────────────────────────────────────
  createUser(input: NewUser): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;

  createAuthSession(token: string, userId: string, expiresAt: string): Promise<void>;
  getAuthSession(token: string): Promise<AuthSessionRecord | null>;
  deleteAuthSession(token: string): Promise<void>;

  /** Assign a role to a user (replaces any existing role — MVP is single-role). */
  setUserRole(userId: string, role: string): Promise<void>;
  getUserRole(userId: string): Promise<string | null>;
  /** Resolve a role to its capability list (from role_capability config). */
  getRoleCapabilities(role: string): Promise<string[]>;
}

// Re-export commonly used domain types for store consumers.
export type { ScenarioRecord, CompiledScenarioRecord, RubricItem, ToolDefinition, SessionUsage };
export type { AnalysisRecord, Evaluation, Improvement };
export type { CoachRecord, CompiledCoachRecord, CourseRecord, CompiledCourseRecord };
