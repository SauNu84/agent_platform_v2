/**
 * In-memory Store implementation — for tests and zero-infra local dev.
 * Mirrors the semantics of the Postgres implementation (db/pg-store.ts); the
 * migrations remain the production source of truth.
 */
import { randomUUID } from 'node:crypto';
import type { CompiledScenarioRecord, KnowledgeBaseDoc, ScenarioRecord } from '@/domain/scenario';
import type { AnalysisRecord } from '@/domain/analysis';
import type { CoachRecord, CompiledCoachRecord } from '@/domain/coach';
import type { CourseRecord, CompiledCourseRecord } from '@/domain/course';
import type {
  ApiKeyRecord, AuditEvent, AuthSessionRecord, CheckoutRecord, CoachMemoryRecord, ConsentRecord, ConsentState, ContentEntityType,
  ContentSourceInput, ContentSourceRecord, CreatorAnalyticsRow, EntitlementRecord,
  KnowledgeBaseRecord, KnowledgeBaseDocRecord, NewKnowledgeBase, NewKnowledgeBaseDoc,
  NewAnalysis, NewCoachMemory, NewConsent, NewSession, NewUser, OwnerOpts, ScenarioFilter,
  SessionEventRow, SessionHistoryRow, SessionRecord, SessionTranscript, ShareLinkRecord, Store,
  UserRecord, VoiceUsageRecord, WebhookRecord,
} from './store';
import { genShareCode } from '@/lib/short-code';
import { ROLE_CAPABILITIES } from '@/auth/rbac';

function nowIso(): string {
  return new Date().toISOString();
}

function matchesMetadata(rec: ScenarioRecord, want?: Record<string, unknown>): boolean {
  if (!want) return true;
  return Object.entries(want).every(([k, v]) => rec.metadata[k] === v);
}

export class MemoryStore implements Store {
  private scenarios = new Map<string, ScenarioRecord>();      // by slug
  private idToSlug = new Map<string, string>();
  private sources = new Map<string, ContentSourceRecord>();   // by `${type}:${id}`
  private sessions = new Map<string, SessionRecord>();        // by id
  private events: SessionEventRow[] = [];
  private usage = new Map<string, VoiceUsageRecord>();        // by sessionId
  private analyses = new Map<string, AnalysisRecord>();       // by sessionId
  private entitlements = new Map<string, EntitlementRecord>(); // by userId
  private checkouts = new Map<string, CheckoutRecord>();       // by id (SAU-250)
  private apiKeys = new Map<string, ApiKeyRecord>();           // by id (SAU-252)
  private webhooks = new Map<string, WebhookRecord>();         // by id (SAU-252)
  // ── Slice 3 ──
  private coaches = new Map<string, CoachRecord>();           // by slug
  private coachIdToSlug = new Map<string, string>();
  private courses = new Map<string, CourseRecord>();          // by slug
  private courseIdToSlug = new Map<string, string>();
  private memories = new Map<string, CoachMemoryRecord>();    // by id
  private consents: ConsentRecord[] = [];                     // append-only
  private audit: (AuditEvent & { ts: string })[] = [];        // append-only
  private shareLinks = new Map<string, ShareLinkRecord>();    // by code
  private scenarioToShareCode = new Map<string, string>();    // scenarioId → code (idempotency)
  // ── Knowledge Base (SAU-243) ──
  private kbs = new Map<string, KnowledgeBaseRecord>();        // by id (docCount kept current)
  private kbDocs: KnowledgeBaseDocRecord[] = [];               // array order = upload order
  private scenarioKbLinks: Array<{ scenarioId: string; kbId: string; createdAt: string }> = []; // push order = link order
  // ── Slice 5: auth + RBAC ──
  private users = new Map<string, UserRecord>();              // by id
  private usersByEmail = new Map<string, string>();           // email → id
  private authSessions = new Map<string, AuthSessionRecord>();// by token
  private userRoles = new Map<string, string>();              // userId → role
  // role → capabilities; seeded to mirror migration 0005 (editable config).
  private roleCaps = new Map<string, Set<string>>(
    Object.entries(ROLE_CAPABILITIES).map(([r, caps]) => [r, new Set(caps)]),
  );

  async listScenarios(filter?: ScenarioFilter): Promise<ScenarioRecord[]> {
    let out = [...this.scenarios.values()];
    if (filter?.isPublic !== undefined) out = out.filter((s) => s.isPublic === filter.isPublic);
    out = out.filter((s) => matchesMetadata(s, filter?.metadata));
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getScenarioBySlug(slug: string): Promise<ScenarioRecord | null> {
    return this.scenarios.get(slug) ?? null;
  }

  async getScenarioById(id: string): Promise<ScenarioRecord | null> {
    const slug = this.idToSlug.get(id);
    return slug ? this.scenarios.get(slug) ?? null : null;
  }

  async createScenario(rec: CompiledScenarioRecord, owner?: OwnerOpts): Promise<ScenarioRecord> {
    if (this.scenarios.has(rec.slug)) {
      throw new Error(`scenario with slug "${rec.slug}" already exists`);
    }
    const id = randomUUID();
    const ts = nowIso();
    const full: ScenarioRecord = { id, createdAt: ts, updatedAt: ts, ownerUserId: owner?.ownerUserId ?? null, ...rec };
    this.scenarios.set(rec.slug, full);
    this.idToSlug.set(id, rec.slug);
    return full;
  }

  async updateScenario(slug: string, patch: Partial<CompiledScenarioRecord>): Promise<ScenarioRecord | null> {
    const existing = this.scenarios.get(slug);
    if (!existing) return null;
    const updated: ScenarioRecord = { ...existing, ...patch, slug: existing.slug, id: existing.id, createdAt: existing.createdAt, updatedAt: nowIso() };
    this.scenarios.set(slug, updated);
    return updated;
  }

  async deleteScenario(slug: string): Promise<boolean> {
    const existing = this.scenarios.get(slug);
    if (!existing) return false;
    this.scenarios.delete(slug);
    this.idToSlug.delete(existing.id);
    this.sources.delete(`scenario:${existing.id}`);
    const code = this.scenarioToShareCode.get(existing.id);
    if (code) { this.shareLinks.delete(code); this.scenarioToShareCode.delete(existing.id); }
    return true;
  }

  async upsertScenarioFromCompile(
    rec: CompiledScenarioRecord,
    source: { repoPath: string; contentHash: string; revision: string | null },
    owner?: OwnerOpts,
  ): Promise<{ scenario: ScenarioRecord; source: ContentSourceRecord; created: boolean }> {
    const existing = this.scenarios.get(rec.slug);
    let scenario: ScenarioRecord;
    let created: boolean;
    if (existing) {
      scenario = { ...existing, ...rec, id: existing.id, slug: existing.slug, ownerUserId: existing.ownerUserId, createdAt: existing.createdAt, updatedAt: nowIso() };
      this.scenarios.set(rec.slug, scenario);
      created = false;
    } else {
      scenario = await this.createScenario(rec, owner);
      created = true;
    }
    const src: ContentSourceRecord = {
      entityType: 'scenario',
      entityId: scenario.id,
      repoPath: source.repoPath,
      contentHash: source.contentHash,
      revision: source.revision,
      compiledAt: nowIso(),
    };
    this.sources.set(`scenario:${scenario.id}`, src);
    return { scenario, source: src, created };
  }

  async getContentSource(entityType: ContentEntityType, entityId: string): Promise<ContentSourceRecord | null> {
    return this.sources.get(`${entityType}:${entityId}`) ?? null;
  }

  // ── Share links (SAU-225) ────────────────────────────────────────────────────
  async createShareLink(scenarioId: string): Promise<ShareLinkRecord> {
    const existingCode = this.scenarioToShareCode.get(scenarioId);
    if (existingCode) return this.shareLinks.get(existingCode)!;
    let code = genShareCode();
    while (this.shareLinks.has(code)) code = genShareCode();   // collision-safe
    const rec: ShareLinkRecord = { code, scenarioId, createdAt: nowIso() };
    this.shareLinks.set(code, rec);
    this.scenarioToShareCode.set(scenarioId, code);
    return rec;
  }

  async getShareLinkByCode(code: string): Promise<ShareLinkRecord | null> {
    return this.shareLinks.get(code) ?? null;
  }

  // ── Knowledge Base (SAU-243) ──────────────────────────────────────────────
  async createKnowledgeBase(input: NewKnowledgeBase, owner?: OwnerOpts): Promise<KnowledgeBaseRecord> {
    const id = randomUUID();
    const ts = nowIso();
    const rec: KnowledgeBaseRecord = {
      id, title: input.title, description: input.description ?? null,
      ownerUserId: owner?.ownerUserId ?? null, createdAt: ts, updatedAt: ts, docCount: 0,
    };
    this.kbs.set(id, rec);
    return { ...rec };
  }

  async listKnowledgeBases(): Promise<KnowledgeBaseRecord[]> {
    return [...this.kbs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((k) => ({ ...k }));
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBaseRecord | null> {
    const k = this.kbs.get(id);
    return k ? { ...k } : null;
  }

  async deleteKnowledgeBase(id: string): Promise<boolean> {
    const existed = this.kbs.delete(id);
    if (existed) {
      this.kbDocs = this.kbDocs.filter((d) => d.kbId !== id);
      this.scenarioKbLinks = this.scenarioKbLinks.filter((l) => l.kbId !== id);
    }
    return existed;
  }

  async addKnowledgeBaseDocument(doc: NewKnowledgeBaseDoc): Promise<KnowledgeBaseDocRecord> {
    const rec: KnowledgeBaseDocRecord = {
      id: randomUUID(), kbId: doc.kbId, filename: doc.filename, contentType: doc.contentType,
      extractedText: doc.extractedText, chars: doc.extractedText.length, byteSize: doc.byteSize,
      createdAt: nowIso(),
    };
    this.kbDocs.push(rec);
    const kb = this.kbs.get(doc.kbId);
    if (kb) { kb.docCount += 1; kb.updatedAt = rec.createdAt; }
    return { ...rec };
  }

  async listKnowledgeBaseDocuments(kbId: string): Promise<KnowledgeBaseDocRecord[]> {
    return this.kbDocs.filter((d) => d.kbId === kbId).map((d) => ({ ...d }));
  }

  async linkScenarioKnowledgeBase(scenarioId: string, kbId: string): Promise<void> {
    if (this.scenarioKbLinks.some((l) => l.scenarioId === scenarioId && l.kbId === kbId)) return;
    this.scenarioKbLinks.push({ scenarioId, kbId, createdAt: nowIso() });
  }

  async unlinkScenarioKnowledgeBase(scenarioId: string, kbId: string): Promise<boolean> {
    const before = this.scenarioKbLinks.length;
    this.scenarioKbLinks = this.scenarioKbLinks.filter((l) => !(l.scenarioId === scenarioId && l.kbId === kbId));
    return this.scenarioKbLinks.length < before;
  }

  async listScenarioKnowledgeBases(scenarioId: string): Promise<KnowledgeBaseRecord[]> {
    return this.scenarioKbLinks
      .filter((l) => l.scenarioId === scenarioId)
      .map((l) => this.kbs.get(l.kbId))
      .filter((k): k is KnowledgeBaseRecord => !!k)
      .map((k) => ({ ...k }));
  }

  async listKnowledgeForScenario(scenarioId: string): Promise<KnowledgeBaseDoc[]> {
    const out: KnowledgeBaseDoc[] = [];
    for (const link of this.scenarioKbLinks.filter((l) => l.scenarioId === scenarioId)) {
      for (const d of this.kbDocs.filter((doc) => doc.kbId === link.kbId)) {
        if (d.extractedText.trim()) out.push({ filename: d.filename, text: d.extractedText });
      }
    }
    return out;
  }

  // ── Coach CRUD ──────────────────────────────────────────────────────────────
  async listCoaches(): Promise<CoachRecord[]> {
    return [...this.coaches.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getCoachBySlug(slug: string): Promise<CoachRecord | null> {
    return this.coaches.get(slug) ?? null;
  }

  async getCoachById(id: string): Promise<CoachRecord | null> {
    const slug = this.coachIdToSlug.get(id);
    return slug ? this.coaches.get(slug) ?? null : null;
  }

  async deleteCoach(slug: string): Promise<boolean> {
    const existing = this.coaches.get(slug);
    if (!existing) return false;
    this.coaches.delete(slug);
    this.coachIdToSlug.delete(existing.id);
    this.sources.delete(`coach:${existing.id}`);
    return true;
  }

  async upsertCoachFromCompile(
    rec: CompiledCoachRecord,
    source: ContentSourceInput,
    owner?: OwnerOpts,
  ): Promise<{ coach: CoachRecord; source: ContentSourceRecord; created: boolean }> {
    let scenarioId: string | null = null;
    if (rec.scenarioRef) {
      const scenario = await this.getScenarioBySlug(rec.scenarioRef);
      if (!scenario) throw new Error(`coach "${rec.slug}" references unknown scenario "${rec.scenarioRef}"`);
      scenarioId = scenario.id;
    }
    const existing = this.coaches.get(rec.slug);
    let coach: CoachRecord;
    let created: boolean;
    if (existing) {
      coach = {
        ...existing, name: rec.name, scenarioId, inlineAiInstructions: rec.inlineAiInstructions,
        memoryScope: rec.memoryScope, retention: rec.retention, schedule: rec.schedule, updatedAt: nowIso(),
      };
      created = false;
    } else {
      const ts = nowIso();
      coach = {
        id: randomUUID(), slug: rec.slug, name: rec.name, scenarioId,
        inlineAiInstructions: rec.inlineAiInstructions, memoryScope: rec.memoryScope,
        retention: rec.retention, schedule: rec.schedule, ownerUserId: owner?.ownerUserId ?? null,
        createdAt: ts, updatedAt: ts,
      };
      created = true;
    }
    this.coaches.set(rec.slug, coach);
    this.coachIdToSlug.set(coach.id, rec.slug);
    const src: ContentSourceRecord = {
      entityType: 'coach', entityId: coach.id, repoPath: source.repoPath,
      contentHash: source.contentHash, revision: source.revision, compiledAt: nowIso(),
    };
    this.sources.set(`coach:${coach.id}`, src);
    return { coach, source: src, created };
  }

  // ── Course CRUD ───────────────────────────────────────────────────────────────
  async listCourses(): Promise<CourseRecord[]> {
    return [...this.courses.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getCourseBySlug(slug: string): Promise<CourseRecord | null> {
    return this.courses.get(slug) ?? null;
  }

  async getCourseById(id: string): Promise<CourseRecord | null> {
    const slug = this.courseIdToSlug.get(id);
    return slug ? this.courses.get(slug) ?? null : null;
  }

  async deleteCourse(slug: string): Promise<boolean> {
    const existing = this.courses.get(slug);
    if (!existing) return false;
    this.courses.delete(slug);
    this.courseIdToSlug.delete(existing.id);
    this.sources.delete(`course:${existing.id}`);
    return true;
  }

  async upsertCourseFromCompile(
    rec: CompiledCourseRecord,
    source: ContentSourceInput,
    owner?: OwnerOpts,
  ): Promise<{ course: CourseRecord; source: ContentSourceRecord; created: boolean }> {
    // Resolve refs (fail loudly on a dangling ref — a course must compose real atoms).
    const scenarioIds: string[] = [];
    for (const ref of rec.scenarioRefs) {
      const scenario = await this.getScenarioBySlug(ref);
      if (!scenario) throw new Error(`course "${rec.slug}" references unknown scenario "${ref}"`);
      scenarioIds.push(scenario.id);
    }
    let coachId: string | null = null;
    if (rec.coachRef) {
      const coach = await this.getCoachBySlug(rec.coachRef);
      if (!coach) throw new Error(`course "${rec.slug}" references unknown coach "${rec.coachRef}"`);
      coachId = coach.id;
    }
    const existing = this.courses.get(rec.slug);
    let course: CourseRecord;
    let created: boolean;
    if (existing) {
      course = { ...existing, name: rec.name, isPublic: rec.isPublic, coachId, scenarioIds, coverImageUrl: rec.coverImageUrl ?? null, updatedAt: nowIso() };
      created = false;
    } else {
      const ts = nowIso();
      course = {
        id: randomUUID(), slug: rec.slug, name: rec.name, isPublic: rec.isPublic,
        coachId, scenarioIds, coverImageUrl: rec.coverImageUrl ?? null, ownerUserId: owner?.ownerUserId ?? null, createdAt: ts, updatedAt: ts,
      };
      created = true;
    }
    this.courses.set(rec.slug, course);
    this.courseIdToSlug.set(course.id, rec.slug);
    const src: ContentSourceRecord = {
      entityType: 'course', entityId: course.id, repoPath: source.repoPath,
      contentHash: source.contentHash, revision: source.revision, compiledAt: nowIso(),
    };
    this.sources.set(`course:${course.id}`, src);
    return { course, source: src, created };
  }

  /** Synchronous bulk seed (dev only) — populate maps without awaiting. */
  seedSync(items: Array<{ record: CompiledScenarioRecord; repoPath: string; contentHash: string }>): void {
    for (const { record, repoPath, contentHash } of items) {
      if (this.scenarios.has(record.slug)) continue;
      const id = randomUUID();
      const ts = nowIso();
      this.scenarios.set(record.slug, { id, createdAt: ts, updatedAt: ts, ownerUserId: null, ...record });
      this.idToSlug.set(id, record.slug);
      this.sources.set(`scenario:${id}`, { entityType: 'scenario', entityId: id, repoPath, contentHash, revision: null, compiledAt: ts });
    }
  }

  /** Synchronous coach seed (dev only) — resolves scenario refs from seeded scenarios. */
  seedCoachesSync(items: Array<{ record: CompiledCoachRecord; repoPath: string; contentHash: string }>): void {
    for (const { record, repoPath, contentHash } of items) {
      if (this.coaches.has(record.slug)) continue;
      let scenarioId: string | null = null;
      if (record.scenarioRef) {
        const sc = this.scenarios.get(record.scenarioRef);
        if (!sc) { console.warn(`[seed] coach ${record.slug}: unknown scenario "${record.scenarioRef}", skipping`); continue; }
        scenarioId = sc.id;
      }
      const id = randomUUID();
      const ts = nowIso();
      this.coaches.set(record.slug, {
        id, slug: record.slug, name: record.name, scenarioId,
        inlineAiInstructions: record.inlineAiInstructions, memoryScope: record.memoryScope,
        retention: record.retention, schedule: record.schedule, ownerUserId: null, createdAt: ts, updatedAt: ts,
      });
      this.coachIdToSlug.set(id, record.slug);
      this.sources.set(`coach:${id}`, { entityType: 'coach', entityId: id, repoPath, contentHash, revision: null, compiledAt: ts });
    }
  }

  /** Synchronous course seed (dev only) — resolves scenario + coach refs. */
  seedCoursesSync(items: Array<{ record: CompiledCourseRecord; repoPath: string; contentHash: string }>): void {
    for (const { record, repoPath, contentHash } of items) {
      if (this.courses.has(record.slug)) continue;
      const scenarioIds: string[] = [];
      let missing = false;
      for (const ref of record.scenarioRefs) {
        const sc = this.scenarios.get(ref);
        if (!sc) { console.warn(`[seed] course ${record.slug}: unknown scenario "${ref}", skipping`); missing = true; break; }
        scenarioIds.push(sc.id);
      }
      if (missing) continue;
      const coachId = record.coachRef ? this.coaches.get(record.coachRef)?.id ?? null : null;
      const id = randomUUID();
      const ts = nowIso();
      this.courses.set(record.slug, {
        id, slug: record.slug, name: record.name, isPublic: record.isPublic,
        coachId, scenarioIds, coverImageUrl: record.coverImageUrl ?? null, ownerUserId: null, createdAt: ts, updatedAt: ts,
      });
      this.courseIdToSlug.set(id, record.slug);
      this.sources.set(`course:${id}`, { entityType: 'course', entityId: id, repoPath, contentHash, revision: null, compiledAt: ts });
    }
  }

  async createSession(input: NewSession): Promise<SessionRecord> {
    const id = randomUUID();
    const rec: SessionRecord = {
      id,
      userId: input.userId ?? null,
      scenarioId: input.scenarioId,
      coachId: input.coachId ?? null,
      courseId: input.courseId ?? null,
      vendor: input.vendor,
      status: 'active',
      startedAt: nowIso(),
      endedAt: null,
      transcript: null,
    };
    this.sessions.set(id, rec);
    return rec;
  }

  async appendSessionEvent(row: SessionEventRow): Promise<void> {
    this.events.push(row);
  }

  async completeSession(
    sessionId: string,
    update: { status: 'completed' | 'failed'; startedAt?: number; endedAt: number; transcript: SessionTranscript },
  ): Promise<SessionRecord | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    s.status = update.status;
    // Record the true session window: the client path posts a transcript whose
    // startedAt predates the row's creation, so align started_at to it.
    if (update.startedAt !== undefined) s.startedAt = new Date(update.startedAt).toISOString();
    s.endedAt = new Date(update.endedAt).toISOString();
    s.transcript = update.transcript;
    return s;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessionsByScenario(scenarioId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.scenarioId === scenarioId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async listSessionsByCourse(courseId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.courseId === courseId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async listSessionsByCoachUser(coachId: string, userId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.coachId === coachId && s.userId === userId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async listSessionEvents(sessionId: string): Promise<SessionEventRow[]> {
    return this.events.filter((e) => e.sessionId === sessionId).sort((a, b) => a.ts - b.ts);
  }

  async recordVoiceUsage(usage: VoiceUsageRecord): Promise<void> {
    this.usage.set(usage.sessionId, usage);
  }

  async getVoiceUsage(sessionId: string): Promise<VoiceUsageRecord | null> {
    return this.usage.get(sessionId) ?? null;
  }

  // ── Slice 2: Analyst projection ───────────────────────────────────────────────
  async upsertAnalysis(rec: NewAnalysis): Promise<AnalysisRecord> {
    const existing = this.analyses.get(rec.sessionId);
    const ts = nowIso();
    const full: AnalysisRecord = {
      ...rec,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.analyses.set(rec.sessionId, full);
    return full;
  }

  async getAnalysis(sessionId: string): Promise<AnalysisRecord | null> {
    return this.analyses.get(sessionId) ?? null;
  }

  // ── Slice 2: History + Creator analytics ──────────────────────────────────────
  async listSessionHistory(userId: string): Promise<SessionHistoryRow[]> {
    const rows: SessionHistoryRow[] = [];
    for (const s of this.sessions.values()) {
      if (s.userId !== userId) continue;
      const scenario = this.scenarios.get(this.idToSlug.get(s.scenarioId) ?? '');
      const analysis = this.analyses.get(s.id);
      const durationMs = s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : 0;
      rows.push({
        sessionId: s.id,
        scenarioId: s.scenarioId,
        scenarioSlug: scenario?.slug ?? '',
        scenarioName: scenario?.name ?? '(deleted scenario)',
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: Math.max(0, durationMs),
        status: s.status,
        analyzed: !!analysis,
        finalScore: analysis ? analysis.evaluation.finalScore : null,
      });
    }
    return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async getCreatorAnalytics(): Promise<CreatorAnalyticsRow[]> {
    const rows: CreatorAnalyticsRow[] = [];
    for (const scenario of this.scenarios.values()) {
      const sessions = [...this.sessions.values()].filter((s) => s.scenarioId === scenario.id);
      const durations = sessions.map((s) =>
        s.endedAt ? Math.max(0, new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) : 0,
      );
      const voiceMinutes = sessions.reduce((sum, s) => sum + (this.usage.get(s.id)?.voiceMinutes ?? 0), 0);
      rows.push({
        scenarioId: scenario.id,
        slug: scenario.slug,
        name: scenario.name,
        sessions: sessions.length,
        avgDurationMs: sessions.length ? Math.round(durations.reduce((a, b) => a + b, 0) / sessions.length) : 0,
        totalVoiceMinutes: Number(voiceMinutes.toFixed(4)),
      });
    }
    return rows.sort((a, b) => b.sessions - a.sessions);
  }

  // ── Slice 2: credit meter + entitlement ───────────────────────────────────────
  async sumVoiceMinutesByUser(userId: string): Promise<number> {
    let sum = 0;
    for (const u of this.usage.values()) {
      if (u.userId === userId) sum += u.voiceMinutes;
    }
    return Number(sum.toFixed(4));
  }

  async getEntitlement(userId: string): Promise<EntitlementRecord | null> {
    return this.entitlements.get(userId) ?? null;
  }

  async upsertEntitlement(rec: EntitlementRecord): Promise<EntitlementRecord> {
    this.entitlements.set(rec.userId, rec);
    return rec;
  }

  // ── Billing checkout (SAU-250) ──────────────────────────────────────────────
  async createCheckout(rec: CheckoutRecord): Promise<CheckoutRecord> {
    this.checkouts.set(rec.id, rec);
    return rec;
  }

  async getCheckout(id: string): Promise<CheckoutRecord | null> {
    return this.checkouts.get(id) ?? null;
  }

  async setCheckoutStatus(id: string, status: 'completed' | 'canceled'): Promise<CheckoutRecord | null> {
    const rec = this.checkouts.get(id);
    if (!rec) return null;
    const next = { ...rec, status };
    this.checkouts.set(id, next);
    return next;
  }

  async listCheckouts(userId: string): Promise<CheckoutRecord[]> {
    return [...this.checkouts.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── Developer Tools (SAU-252) — per-user API keys + webhooks ─────────────────
  async createApiKey(rec: ApiKeyRecord): Promise<ApiKeyRecord> {
    this.apiKeys.set(rec.id, rec);
    return rec;
  }

  async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()]
      .filter((k) => k.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeApiKey(userId: string, id: string): Promise<ApiKeyRecord | null> {
    const rec = this.apiKeys.get(id);
    if (!rec || rec.userId !== userId) return null;
    const next = { ...rec, revokedAt: rec.revokedAt ?? nowIso() };
    this.apiKeys.set(id, next);
    return next;
  }

  async createWebhook(rec: WebhookRecord): Promise<WebhookRecord> {
    this.webhooks.set(rec.id, rec);
    return rec;
  }

  async listWebhooks(userId: string): Promise<WebhookRecord[]> {
    return [...this.webhooks.values()]
      .filter((w) => w.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteWebhook(userId: string, id: string): Promise<boolean> {
    const rec = this.webhooks.get(id);
    if (!rec || rec.userId !== userId) return false;
    return this.webhooks.delete(id);
  }

  // ── Coach memory (ADR-004) — (coach,user)-scoped in-memory analogue of RLS ──
  async writeCoachMemory(rec: NewCoachMemory): Promise<CoachMemoryRecord> {
    const full: CoachMemoryRecord = { ...rec, id: randomUUID(), createdAt: nowIso() };
    this.memories.set(full.id, full);
    return full;
  }

  async listCoachMemory(coachId: string, userId: string): Promise<CoachMemoryRecord[]> {
    const now = Date.now();
    return [...this.memories.values()]
      .filter((m) => m.coachId === coachId && m.userId === userId && Date.parse(m.expiresAt) > now)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async bumpCoachMemoryExpiry(ids: string[], userId: string, expiresAt: string): Promise<void> {
    for (const id of ids) {
      const m = this.memories.get(id);
      if (m && m.userId === userId) m.expiresAt = expiresAt;
    }
  }

  async deleteCoachMemory(coachId: string, userId: string, memoryId: string): Promise<boolean> {
    const m = this.memories.get(memoryId);
    if (!m || m.coachId !== coachId || m.userId !== userId) return false;
    this.memories.delete(memoryId);
    return true;
  }

  async wipeCoachMemory(coachId: string, userId: string): Promise<number> {
    let n = 0;
    for (const [id, m] of this.memories) {
      if (m.coachId === coachId && m.userId === userId) { this.memories.delete(id); n++; }
    }
    return n;
  }

  // ── Consent + audit (ADR-004) — append-only ─────────────────────────────────
  async recordConsent(rec: NewConsent): Promise<ConsentRecord> {
    const full: ConsentRecord = { ...rec, id: randomUUID(), createdAt: nowIso() };
    this.consents.push(full);
    return full;
  }

  async getConsentState(userId: string, scope: string): Promise<ConsentState> {
    const state: ConsentState = { persistentMemory: false, audioRetention: false };
    // Replay the append log in order; the latest action per type wins.
    for (const c of this.consents.filter((c) => c.userId === userId && c.scope === scope)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
      const granted = c.action === 'granted';
      if (c.consentType === 'persistent_memory') state.persistentMemory = granted;
      if (c.consentType === 'audio_retention') state.audioRetention = granted;
    }
    return state;
  }

  async listConsent(userId: string, scope: string): Promise<ConsentRecord[]> {
    return this.consents
      .filter((c) => c.userId === userId && c.scope === scope)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async recordAuditEvent(ev: AuditEvent): Promise<void> {
    this.audit.push({ ...ev, ts: nowIso() });
  }

  async listAuditEvents(subjectUserId: string): Promise<(AuditEvent & { ts: string })[]> {
    return this.audit
      .filter((e) => e.subjectUserId === subjectUserId)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  // ── Slice 5: auth + RBAC ─────────────────────────────────────────────────
  /** Synchronous user seed (dev only) — populate identity maps without awaiting. */
  seedUsersSync(items: Array<{ email: string; passwordHash: string; displayName: string; role: string }>): void {
    for (const u of items) {
      const email = u.email.trim().toLowerCase();
      if (this.usersByEmail.has(email)) continue;
      const id = randomUUID();
      const ts = nowIso();
      this.users.set(id, { id, email, passwordHash: u.passwordHash, displayName: u.displayName, createdAt: ts, updatedAt: ts });
      this.usersByEmail.set(email, id);
      this.userRoles.set(id, u.role);
    }
  }

  async createUser(input: NewUser): Promise<UserRecord> {
    const email = input.email.trim().toLowerCase();
    if (this.usersByEmail.has(email)) throw new Error(`user with email "${email}" already exists`);
    const id = input.id ?? randomUUID();
    const ts = nowIso();
    const rec: UserRecord = { id, email, passwordHash: input.passwordHash, displayName: input.displayName, createdAt: ts, updatedAt: ts };
    this.users.set(id, rec);
    this.usersByEmail.set(email, id);
    return rec;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const id = this.usersByEmail.get(email.trim().toLowerCase());
    return id ? this.users.get(id) ?? null : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async createAuthSession(token: string, userId: string, expiresAt: string): Promise<void> {
    this.authSessions.set(token, { token, userId, expiresAt });
  }

  async getAuthSession(token: string): Promise<AuthSessionRecord | null> {
    return this.authSessions.get(token) ?? null;
  }

  async deleteAuthSession(token: string): Promise<void> {
    this.authSessions.delete(token);
  }

  async setUserRole(userId: string, role: string): Promise<void> {
    this.userRoles.set(userId, role);
  }

  async getUserRole(userId: string): Promise<string | null> {
    return this.userRoles.get(userId) ?? null;
  }

  async getRoleCapabilities(role: string): Promise<string[]> {
    return [...(this.roleCaps.get(role) ?? new Set<string>())];
  }
}
