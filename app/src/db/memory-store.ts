/**
 * In-memory Store implementation — for tests and zero-infra local dev.
 * Mirrors the semantics of the Postgres implementation (db/pg-store.ts); the
 * migrations remain the production source of truth.
 */
import { randomUUID } from 'node:crypto';
import type { CompiledScenarioRecord, ScenarioRecord } from '@/domain/scenario';
import type {
  ContentSourceRecord, NewSession, ScenarioFilter, SessionEventRow, SessionRecord,
  SessionTranscript, Store, VoiceUsageRecord,
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

  async getContentSource(entityType: 'scenario' | 'coach' | 'course', entityId: string): Promise<ContentSourceRecord | null> {
    return this.sources.get(`${entityType}:${entityId}`) ?? null;
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

  async createSession(input: NewSession): Promise<SessionRecord> {
    const id = randomUUID();
    const rec: SessionRecord = {
      id,
      userId: input.userId ?? null,
      scenarioId: input.scenarioId,
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

  async listSessionEvents(sessionId: string): Promise<SessionEventRow[]> {
    return this.events.filter((e) => e.sessionId === sessionId).sort((a, b) => a.ts - b.ts);
  }

  async recordVoiceUsage(usage: VoiceUsageRecord): Promise<void> {
    this.usage.set(usage.sessionId, usage);
  }

  async getVoiceUsage(sessionId: string): Promise<VoiceUsageRecord | null> {
    return this.usage.get(sessionId) ?? null;
  }
}
