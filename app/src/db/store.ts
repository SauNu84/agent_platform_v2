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
import type {
  Debtor, NewDebtor, CollectionsAuditInput, CollectionsAuditRecord, CollectionsAuditFilter,
  CollectionsPolicyRecord, CollectionsPolicyInput,
} from '@/domain/collections';
import type { NewCallAttempt, CallAttemptRecord } from '@/domain/collections-outcome';

export type ContentEntityType = 'scenario' | 'coach' | 'course';

// ── AuthN + RBAC (Slice 5, SAU-229 / ADR-007) ──────────────────────────────
/** A local-identity user (email + password hash). */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  /** the user's clinic/org (SAU-275); null for platform/consumer users. */
  clinicId: string | null;
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
  /** owning clinic/org for multi-clinic PHI scoping (SAU-275); null = platform. */
  clinicId?: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string | null;
  /** owning clinic/org for multi-clinic PHI scoping (SAU-275); null = platform. */
  clinicId: string | null;
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
  /** voice tier this session was routed at (SAU-256). */
  tier?: 'free' | 'paid' | null;
  /** the config-driven engine model id selected by the tiered router (SAU-256). */
  engine?: string | null;
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

/** Blended voice usage aggregated by tier + engine (SAU-256 observability). */
export interface VoiceUsageByTierRow {
  tier: string | null;
  engine: string | null;
  sessions: number;
  voiceMinutes: number;
  totalTokens: number;
  cachedTokens: number;
}

/** Per-user voice-minute entitlement (plan + caps). */
export interface EntitlementRecord {
  userId: string;
  plan: 'free' | 'paid';
  freeMinutes: number;
  paidMinutes: number;
  /** Named subscription tier for the Billing UI (SAU-250). Defaults to 'free'. */
  planTier?: 'free' | 'standard' | 'premium';
}

/** A checkout intent — the hand-off to an external payment provider (SAU-250). */
export interface CheckoutRecord {
  id: string;
  userId: string;
  planId: string;
  billingCycle: 'monthly' | 'annual';
  provider: string;
  amountCents: number;
  status: 'pending' | 'completed' | 'canceled';
  createdAt: string;
}

/** A shareable short link mapping a URL-safe code → scenario (SAU-225). */
export interface ShareLinkRecord {
  code: string;
  scenarioId: string;
  createdAt: string;
}

// ── Developer Tools (SAU-252): programmatic access keys + webhooks ───────────
/** A minted API key. The full secret is returned ONCE at creation, never stored. */
export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  /** Non-secret display stub, e.g. "ak_live_8fA2c1…". */
  keyPrefix: string;
  /** SHA-256 of the full key (the secret itself is never persisted). */
  keyHash: string;
  lastUsedAt: string | null;
  /** null = active; set = revoked (soft delete). */
  revokedAt: string | null;
  createdAt: string;
}

/** A registered webhook endpoint that receives event callbacks. */
export interface WebhookRecord {
  id: string;
  userId: string;
  url: string;
  /** Signing secret (whsec_…) shown to the user to verify callback authenticity. */
  secret: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

// ── User settings (SAU-253) — generic per-user key/value preferences ─────────
// Backs the Language / My Voice / Integrations Settings tabs. `value` is a small
// JSON config blob (no secrets/PII). Scoped at the app layer by user_id.
export interface UserSettingRecord {
  key: string;
  value: Record<string, unknown>;
  updatedAt: string;
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

// ── PHI access audit log (SAU-275, §164.312(b)) — append-only, tamper-evident ─
/** The principal touching PHI: a human user, a programmatic agent, or system. */
export type PhiActorLabel = string; // 'user:<id>' | 'agent:<scenario>' | 'system' | 'anonymous'

/** One PHI read/write/purge to record. `refs` carries counts/ids only — NEVER PHI. */
export interface PhiAccessInput {
  action: 'read' | 'write' | 'purge';
  /** which PHI field, e.g. 'clinic_session_outcome.intake' | 'session.transcript'. */
  entity: string;
  /** the PHI subject key (session id), when known. */
  entityId?: string | null;
  /** the owning clinic/org, when known. */
  clinicId?: string | null;
  /** override the actor label (defaults to the bound actor, else 'system'). */
  actorLabel?: PhiActorLabel;
  refs?: Record<string, unknown>;
}

/** A persisted PHI access record (append-only). */
export interface PhiAccessRecord {
  id: string;
  seq: number;
  ts: string;
  actorUserId: string | null;
  actorLabel: PhiActorLabel;
  action: 'read' | 'write' | 'purge';
  entity: string;
  entityId: string | null;
  clinicId: string | null;
  refs: Record<string, unknown>;
  /** base64 HMAC-SHA256 over the canonical row (tamper-evidence). */
  integrity: string;
}

export interface PhiAccessFilter {
  entityId?: string;
  clinicId?: string;
  actorUserId?: string;
  limit?: number;
}

// ── Product analytics events (SAU-350, WS5) — append-only, PII/PHI-FREE ───────
// Powers the CMO funnel/activation/retention read-models. `props` holds
// ids/enums/counts only (taxonomy + PII guard in domain/analytics-events.ts).
export interface ProductEventInput {
  /** canonical taxonomy name, e.g. 'clinic.session.completed'. */
  event: string;
  /** archetype dimension; defaults to the event-name prefix when omitted. */
  archetype?: string;
  /** modality the event came from (web/voice/sms/batch/...). */
  surface?: string | null;
  /** INTERNAL non-PII id for unique/retention cohorts (NOT a name/email/phone). */
  actorId?: string | null;
  /** owning clinic/org; null = platform-wide event. */
  tenantId?: string | null;
  sessionId?: string | null;
  scenarioId?: string | null;
  /** ids/enums/counts ONLY — validated PII-free at the track() boundary. */
  props?: Record<string, string | number | boolean | null>;
  /** event time (epoch ms); defaults to now(). Lets tests pin a window. */
  ts?: number;
}

export interface ProductEventRecord {
  id: string;
  ts: string;
  event: string;
  archetype: string;
  surface: string | null;
  actorId: string | null;
  tenantId: string | null;
  sessionId: string | null;
  scenarioId: string | null;
  props: Record<string, unknown>;
}

export interface ProductEventFilter {
  archetype?: string;
  /** restrict to these event names (e.g. one journey's steps). */
  events?: string[];
  tenantId?: string;
  /** ISO timestamps bounding the window (inclusive `since`, exclusive `until`). */
  since?: string;
  until?: string;
  limit?: number;
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

// ── Clinic Intake & Booking outcome (SAU-267) — task-completion model ────────
export type ClinicOutcome = 'booked' | 'no_slot' | 'escalated';

/** One per session: did the action-taking agent complete its task? + intake JSON. */
export interface ClinicOutcomeRecord {
  sessionId: string;
  scenarioId: string;
  userId: string | null;
  /** owning clinic/org for multi-clinic PHI scoping (SAU-275); null = platform. */
  clinicId?: string | null;
  outcome: ClinicOutcome;
  /** vendor calendar event id — proof of completion when booked. */
  eventId: string | null;
  eventLink: string | null;
  doctorId: string | null;
  doctorName: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  calendar: string | null;
  simulated: boolean;
  /** structured intake JSON extracted from the transcript (AC #4). */
  intake: Record<string, unknown>;
  /** why the call escalated to a human (SAU-273 WS4); null unless escalated. */
  escalationReason?: string | null;
  /** how the escalation was handled: warm_transfer | voicemail | callback | none. */
  handoffAction?: string | null;
  /** dispatch summary of the booking confirmations: sent|partial|blocked|skipped|failed|none. */
  confirmationStatus?: string | null;
  /** was the call handled outside clinic hours? (SAU-301 dashboard after-hours metric). */
  afterHours?: boolean | null;
  createdAt?: string;
}

/**
 * Non-PHI projection of a booking outcome for the per-clinic ops dashboard
 * (SAU-301). Deliberately omits `intake` so the metrics read-model never
 * decrypts patient identifiers nor emits a PHI read into the audit log.
 */
export interface ClinicOutcomeSummary {
  sessionId: string;
  outcome: ClinicOutcome;
  eventId: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  escalationReason: string | null;
  handoffAction: string | null;
  confirmationStatus: string | null;
  afterHours: boolean | null;
  simulated: boolean;
  createdAt: string;
}

/** One per attempted outbound confirmation/notice (SAU-273 WS3). No PHI. */
export interface ClinicNotificationRecord {
  id?: string;
  sessionId: string | null;
  userId: string | null;
  clinicId?: string | null;
  /** opaque booking reference (calendar event id). */
  reference: string;
  channel: 'sms' | 'email';
  audience: 'patient' | 'clinic';
  /** masked recipient — never the raw phone/email. */
  recipientMasked: string;
  status: 'sent' | 'failed' | 'blocked' | 'skipped';
  providerId?: string | null;
  simulated: boolean;
  error?: string | null;
  createdAt?: string;
}

// ── Multi-clinic tenancy (SAU-301, Phase 2 · WS-B) ──────────────────────────
/** A clinic/tenant row with its authored definition (config) + provenance. */
/**
 * Per-tenant voice engine GRADE (SAU-525): which engine class a tenant's phone
 * calls run on, independent of the owner's billing tier. `standard` = the cost
 * engine (gpt-realtime-mini by default), `premium` = the "Super" engine. The
 * concrete model ids remain a config seam in `voice/engine-router`.
 */
export type ClinicVoiceEngine = 'standard' | 'premium';

export interface ClinicRecord {
  id: string;
  slug: string;
  name: string;
  /** authored ClinicConfig (non-PHI); null until the operator saves a definition. */
  config: Record<string, unknown> | null;
  createdByUserId: string | null;
  /** E.164 number inbound calls to this tenant arrive on (SAU-525); null = not phone-reachable. */
  phoneNumber: string | null;
  /** engine grade for this tenant's calls (SAU-525); null = archetype default. */
  voiceEngine: ClinicVoiceEngine | null;
  createdAt: string;
}

export interface NewClinic {
  slug: string;
  name: string;
  createdByUserId: string;
  config?: Record<string, unknown> | null;
  phoneNumber?: string | null;
  voiceEngine?: ClinicVoiceEngine | null;
}

/** Patch for the telephony binding (SAU-525); `undefined` leaves a field untouched. */
export interface ClinicTelephonyPatch {
  phoneNumber?: string | null;
  voiceEngine?: ClinicVoiceEngine | null;
}

/** A user ↔ clinic membership (the switcher's list + active-clinic gate). */
/** Who a clinic's calls are billed to, and which rule picked them (SAU-525). */
export interface ClinicPayer {
  userId: string;
  /** 'earliest_owner' ⇒ the creator was skipped or absent — logged, never silent. */
  source: 'creator' | 'earliest_owner';
}

export interface ClinicMemberRecord {
  clinicId: string;
  userId: string;
  role: string;
  createdAt: string;
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
  /** Blended voice usage grouped by tier + engine (SAU-256 cost observability). */
  voiceUsageByTier(): Promise<VoiceUsageByTierRow[]>;

  // ── Slice 2: Analyst projection ───────────────────────────────────────────────
  upsertAnalysis(rec: NewAnalysis): Promise<AnalysisRecord>;
  getAnalysis(sessionId: string): Promise<AnalysisRecord | null>;

  // ── Clinic Intake & Booking outcome (SAU-267) — task-completion projection ────
  /** Upsert the session's outcome + extracted intake. Idempotent per session. */
  recordClinicOutcome(rec: ClinicOutcomeRecord): Promise<ClinicOutcomeRecord>;
  getClinicOutcome(sessionId: string): Promise<ClinicOutcomeRecord | null>;
  /** Append a confirmation/notice delivery record (SAU-273 WS3). */
  recordClinicNotification(rec: ClinicNotificationRecord): Promise<ClinicNotificationRecord>;
  /** All delivery records for a session, newest first. */
  listClinicNotifications(sessionId: string): Promise<ClinicNotificationRecord[]>;

  // ── Multi-clinic tenancy (SAU-301, WS-B) — clinics + memberships ────────────
  /** Provision a clinic (RLS: creator-stamped self-provision). */
  createClinic(input: NewClinic): Promise<ClinicRecord>;
  getClinicById(id: string): Promise<ClinicRecord | null>;
  getClinicBySlug(slug: string): Promise<ClinicRecord | null>;
  /** Clinics the user is a member of (the switcher list), newest first. */
  listClinicsForUser(userId: string): Promise<ClinicRecord[]>;
  /** Replace a clinic's authored definition (RLS: must be a member). */
  updateClinicConfig(clinicId: string, config: Record<string, unknown>): Promise<ClinicRecord>;
  /**
   * Tenant lookup for an inbound call (SAU-525): the clinic bound to a dialed E.164
   * number, or null. Callers run this under a system actor — RLS would otherwise
   * hide every clinic from a request that has no user principal.
   */
  getClinicByPhoneNumber(phoneNumber: string): Promise<ClinicRecord | null>;
  /**
   * The user a tenant's calls are billed to (SAU-525): the creator WHILE they are
   * still an `owner` member, else the earliest `owner` member. A creator who left
   * or was downgraded is never charged. null when no current owner ⇒ not billable.
   */
  getClinicPayer(clinicId: string): Promise<ClinicPayer | null>;
  /** Update the telephony binding (RLS: must be a member). Rejects a number already bound elsewhere. */
  updateClinicTelephony(clinicId: string, patch: ClinicTelephonyPatch): Promise<ClinicRecord>;
  /** Add a user↔clinic membership (idempotent on the PK). */
  addClinicMember(clinicId: string, userId: string, role?: string): Promise<void>;
  /** True when the user belongs to the clinic (gates active-clinic selection). */
  isClinicMember(clinicId: string, userId: string): Promise<boolean>;
  /** Non-PHI booking-outcome summaries for one clinic (RLS-scoped), newest first — dashboard read-model. */
  listClinicOutcomesForClinic(clinicId: string): Promise<ClinicOutcomeSummary[]>;
  /** All notification deliveries for one clinic (RLS-scoped) — dashboard compliance tile. */
  listClinicNotificationsForClinic(clinicId: string): Promise<ClinicNotificationRecord[]>;

  // ── Slice 2: History (read-model) + Creator analytics ─────────────────────────
  listSessionHistory(userId: string): Promise<SessionHistoryRow[]>;
  getCreatorAnalytics(): Promise<CreatorAnalyticsRow[]>;

  // ── Slice 2: credit meter + entitlement ───────────────────────────────────────
  sumVoiceMinutesByUser(userId: string): Promise<number>;
  /**
   * Voice minutes a user has used since `sinceMs` (epoch ms), by session start
   * time. Backs the SAU-257 monthly cap: passing the start of the current month
   * gives the month-to-date usage that the free allotment resets against.
   */
  sumVoiceMinutesByUserSince(userId: string, sinceMs: number): Promise<number>;
  getEntitlement(userId: string): Promise<EntitlementRecord | null>;
  upsertEntitlement(rec: EntitlementRecord): Promise<EntitlementRecord>;

  // ── Billing checkout (SAU-250): provider hand-off intent ──────────────────────
  createCheckout(rec: CheckoutRecord): Promise<CheckoutRecord>;
  getCheckout(id: string): Promise<CheckoutRecord | null>;
  /** Mark a checkout completed/canceled. Idempotent on the terminal state. */
  setCheckoutStatus(id: string, status: 'completed' | 'canceled'): Promise<CheckoutRecord | null>;
  /** A user's recent checkout intents, newest first (Billing "Purchases" table). */
  listCheckouts(userId: string): Promise<CheckoutRecord[]>;

  // ── Developer Tools (SAU-252): API keys + webhook endpoints, per-user ─────────
  createApiKey(rec: ApiKeyRecord): Promise<ApiKeyRecord>;
  /** A user's API keys, newest first (revoked keys included, flagged via revokedAt). */
  listApiKeys(userId: string): Promise<ApiKeyRecord[]>;
  /** Soft-revoke a key the user owns. Returns null if not found / not theirs. */
  revokeApiKey(userId: string, id: string): Promise<ApiKeyRecord | null>;
  createWebhook(rec: WebhookRecord): Promise<WebhookRecord>;
  /** A user's webhook endpoints, newest first. */
  listWebhooks(userId: string): Promise<WebhookRecord[]>;
  /** Delete a webhook the user owns. Returns false if not found / not theirs. */
  deleteWebhook(userId: string, id: string): Promise<boolean>;

  // ── User settings (SAU-253) — per-user key/value preferences ────────────────
  /** Read one setting for a user, or null if unset. */
  getUserSetting(userId: string, key: string): Promise<UserSettingRecord | null>;
  /** All settings for a user (used to hydrate the Settings hub). */
  listUserSettings(userId: string): Promise<UserSettingRecord[]>;
  /** Upsert a single setting (replaces the value). */
  putUserSetting(userId: string, key: string, value: Record<string, unknown>): Promise<UserSettingRecord>;
  /** Clear a setting. Returns false if it was not set. */
  deleteUserSetting(userId: string, key: string): Promise<boolean>;

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

  // ── Product analytics events (SAU-350, WS5) — append-only, PII/PHI-FREE ──────
  /** Append one product-usage event. Callers MUST go through track() so props are
   *  validated PII-free before this write. */
  recordProductEvent(ev: ProductEventInput): Promise<void>;
  /** Query the product-event stream for the CMO read-models (funnel/retention). */
  queryProductEvents(filter: ProductEventFilter): Promise<ProductEventRecord[]>;

  // ── PHI access audit log (SAU-275) — append-only, tamper-evident ────────────
  /** Append one PHI read/write record (who/what/when), HMAC-stamped at write. */
  recordPhiAccess(entry: PhiAccessInput): Promise<void>;
  /** Query the PHI access log (RLS-scoped to the caller's clinic / own access). */
  listPhiAccess(filter: PhiAccessFilter): Promise<PhiAccessRecord[]>;

  // ── Collections debtors + compliance ledger (SAU-333, WS-2) ─────────────────
  /** Upsert a synthetic debtor (PII encrypted at the boundary). Idempotent on (clinic, externalRef). */
  upsertDebtor(input: NewDebtor): Promise<Debtor>;
  /** Read a debtor by id (RLS-scoped; PII decrypted in-process). */
  getDebtor(id: string): Promise<Debtor | null>;
  /** Read a debtor by (clinic, externalRef) — the ingestion idempotency key. */
  getDebtorByRef(clinicId: string, externalRef: string): Promise<Debtor | null>;
  /** All debtors for a lender/tenant (RLS-scoped), newest first. */
  listDebtorsForClinic(clinicId: string): Promise<Debtor[]>;
  /** Record an opt-out / do-not-call for a debtor (sets opted_out + appends an audit row). */
  setDebtorOptOut(id: string, optedOut: boolean): Promise<Debtor | null>;
  /** Set the open-dispute flag for a debtor (an open dispute pauses calling). */
  setDebtorDispute(id: string, disputeOpen: boolean): Promise<Debtor | null>;
  // ── Per-lender collections policy (SAU-521, migration 0026) ────────────────
  /**
   * Read one lender's collections policy (RLS-scoped), or null when none has been
   * configured. Null is a MEANINGFUL state, not an error: under SAU-521 it means the
   * tenant is not cleared to dial anyone.
   */
  getCollectionsPolicy(clinicId: string): Promise<CollectionsPolicyRecord | null>;
  /** Create or update one lender's collections policy (RLS-scoped). Absent fields are left as-is. */
  upsertCollectionsPolicy(input: CollectionsPolicyInput): Promise<CollectionsPolicyRecord>;

  /** Append one compliance event (dial decision / outcome / opt-out / purge) — HMAC hash-chained. */
  recordCollectionsAudit(entry: CollectionsAuditInput): Promise<CollectionsAuditRecord>;
  /** Query the compliance ledger (RLS-scoped to the caller's tenant), newest first. */
  listCollectionsAudit(filter: CollectionsAuditFilter): Promise<CollectionsAuditRecord[]>;

  // ── Collections call-attempt outcomes (SAU-335, WS-4) ───────────────────────
  /** Record one call-attempt outcome and append the matching compliance audit event. */
  recordCallAttempt(input: NewCallAttempt): Promise<CallAttemptRecord>;
  /** All attempts for one debtor (RLS-scoped), newest first. */
  listCallAttemptsForDebtor(clinicId: string, debtorId: string): Promise<CallAttemptRecord[]>;
  /** All attempts for a lender/tenant (RLS-scoped), newest first. */
  listCallAttemptsForClinic(clinicId: string): Promise<CallAttemptRecord[]>;

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
