/**
 * In-memory Store implementation — for tests and zero-infra local dev.
 * Mirrors the semantics of the Postgres implementation (db/pg-store.ts); the
 * migrations remain the production source of truth.
 */
import { randomUUID } from 'node:crypto';
import type { CompiledScenarioRecord, ScenarioRecord } from '@/domain/scenario';
import type { CoachRecord, CompiledCoachRecord } from '@/domain/coach';
import type { CourseRecord, CompiledCourseRecord } from '@/domain/course';
import type {
  AuditEvent, CoachMemoryRecord, ConsentRecord, ConsentState, ContentEntityType,
  ContentSourceInput, ContentSourceRecord, NewCoachMemory, NewConsent, NewSession,
  ScenarioFilter, SessionEventRow, SessionRecord, SessionTranscript, Store, VoiceUsageRecord,
} from './store';

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
  // ── Slice 3 ──
  private coaches = new Map<string, CoachRecord>();           // by slug
  private coachIdToSlug = new Map<string, string>();
  private courses = new Map<string, CourseRecord>();          // by slug
  private courseIdToSlug = new Map<string, string>();
  private memories = new Map<string, CoachMemoryRecord>();    // by id
  private consents: ConsentRecord[] = [];                     // append-only
  private audit: (AuditEvent & { ts: string })[] = [];        // append-only

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

  async createScenario(rec: CompiledScenarioRecord): Promise<ScenarioRecord> {
    if (this.scenarios.has(rec.slug)) {
      throw new Error(`scenario with slug "${rec.slug}" already exists`);
    }
    const id = randomUUID();
    const ts = nowIso();
    const full: ScenarioRecord = { id, createdAt: ts, updatedAt: ts, ...rec };
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
    return true;
  }

  async upsertScenarioFromCompile(
    rec: CompiledScenarioRecord,
    source: { repoPath: string; contentHash: string; revision: string | null },
  ): Promise<{ scenario: ScenarioRecord; source: ContentSourceRecord; created: boolean }> {
    const existing = this.scenarios.get(rec.slug);
    let scenario: ScenarioRecord;
    let created: boolean;
    if (existing) {
      scenario = { ...existing, ...rec, id: existing.id, slug: existing.slug, createdAt: existing.createdAt, updatedAt: nowIso() };
      this.scenarios.set(rec.slug, scenario);
      created = false;
    } else {
      scenario = await this.createScenario(rec);
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
        retention: rec.retention, schedule: rec.schedule, createdAt: ts, updatedAt: ts,
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
      course = { ...existing, name: rec.name, isPublic: rec.isPublic, coachId, scenarioIds, updatedAt: nowIso() };
      created = false;
    } else {
      const ts = nowIso();
      course = {
        id: randomUUID(), slug: rec.slug, name: rec.name, isPublic: rec.isPublic,
        coachId, scenarioIds, createdAt: ts, updatedAt: ts,
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
      this.scenarios.set(record.slug, { id, createdAt: ts, updatedAt: ts, ...record });
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
        retention: record.retention, schedule: record.schedule, createdAt: ts, updatedAt: ts,
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
        coachId, scenarioIds, createdAt: ts, updatedAt: ts,
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
    update: { status: 'completed' | 'failed'; endedAt: number; transcript: SessionTranscript },
  ): Promise<SessionRecord | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    s.status = update.status;
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
}
