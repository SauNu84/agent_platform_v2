/**
 * Postgres Store implementation (production). Backed by db/migrations/0001.
 * Uses a single pooled connection; jsonb columns map to/from the TS shapes.
 */
import { Pool, PoolClient } from 'pg';
import type { CompiledScenarioRecord, RubricItem, ScenarioRecord } from '@/domain/scenario';
import type { ToolDefinition } from '@/voice/realtime-interface';
import type { CoachRecord, CompiledCoachRecord, CoachSchedule } from '@/domain/coach';
import type { CourseRecord, CompiledCourseRecord } from '@/domain/course';
import type {
  AuditEvent, CoachMemoryRecord, ConsentRecord, ConsentState, ContentEntityType,
  ContentSourceInput, ContentSourceRecord, NewCoachMemory, NewConsent, NewSession,
  ScenarioFilter, SessionEventRow, SessionRecord, SessionTranscript, Store, VoiceUsageRecord,
} from './store';

// pg returns untyped rows; `Row` documents that we map them explicitly below.
type Row = Record<string, any>;

function rowToScenario(r: Row): ScenarioRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description ?? null,
    aiInstructions: r.ai_instructions,
    rubric: (r.rubric ?? []) as RubricItem[],
    isPublic: r.is_public,
    voiceName: r.voice_name,
    languageCode: r.language_code,
    tools: (r.tools ?? []) as ToolDefinition[],
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function rowToSession(r: Row): SessionRecord {
  return {
    id: r.id,
    userId: r.user_id ?? null,
    scenarioId: r.scenario_id,
    coachId: r.coach_id ?? null,
    courseId: r.course_id ?? null,
    vendor: r.vendor,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    transcript: (r.transcript ?? null) as SessionTranscript | null,
  };
}

function rowToCoach(r: Row): CoachRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    scenarioId: r.scenario_id ?? null,
    inlineAiInstructions: r.inline_ai_instructions ?? null,
    memoryScope: r.memory_scope,
    retention: r.retention,
    schedule: (r.schedule ?? {}) as CoachSchedule,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** Serialize a JS embedding to the pgvector text literal '[a,b,c]'. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Parse a pgvector value (text literal or array) back to a JS number[]. */
function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') {
    const inner = v.replace(/^\[|\]$/g, '').trim();
    return inner ? inner.split(',').map(Number) : [];
  }
  return [];
}

function rowToMemory(r: Row): CoachMemoryRecord {
  return {
    id: r.id,
    coachId: r.coach_id,
    userId: r.user_id,
    kind: r.kind,
    content: r.content,
    embedding: parseVector(r.embedding),
    sourceSessionId: r.source_session_id ?? null,
    salience: Number(r.salience),
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export class PgStore implements Store {
  constructor(private pool: Pool) {}

  async listScenarios(filter?: ScenarioFilter): Promise<ScenarioRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.isPublic !== undefined) {
      params.push(filter.isPublic);
      clauses.push(`is_public = $${params.length}`);
    }
    if (filter?.metadata && Object.keys(filter.metadata).length) {
      params.push(JSON.stringify(filter.metadata));
      clauses.push(`metadata @> $${params.length}::jsonb`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query(`SELECT * FROM scenario ${where} ORDER BY created_at DESC`, params);
    return rows.map(rowToScenario);
  }

  async getScenarioBySlug(slug: string): Promise<ScenarioRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM scenario WHERE slug = $1', [slug]);
    return rows[0] ? rowToScenario(rows[0]) : null;
  }

  async getScenarioById(id: string): Promise<ScenarioRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM scenario WHERE id = $1', [id]);
    return rows[0] ? rowToScenario(rows[0]) : null;
  }

  async createScenario(rec: CompiledScenarioRecord): Promise<ScenarioRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO scenario (slug, name, description, ai_instructions, rubric, is_public, voice_name, language_code, tools, metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING *`,
      [rec.slug, rec.name, rec.description, rec.aiInstructions, JSON.stringify(rec.rubric), rec.isPublic,
        rec.voiceName, rec.languageCode, JSON.stringify(rec.tools), JSON.stringify(rec.metadata)],
    );
    return rowToScenario(rows[0]);
  }

  async updateScenario(slug: string, patch: Partial<CompiledScenarioRecord>): Promise<ScenarioRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const col: Record<string, string> = {
      name: 'name', description: 'description', aiInstructions: 'ai_instructions',
      isPublic: 'is_public', voiceName: 'voice_name', languageCode: 'language_code',
    };
    const jsonCol: Record<string, string> = { rubric: 'rubric', tools: 'tools', metadata: 'metadata' };
    for (const [k, v] of Object.entries(patch)) {
      if (k in col) { params.push(v); sets.push(`${col[k]} = $${params.length}`); }
      else if (k in jsonCol) { params.push(JSON.stringify(v)); sets.push(`${jsonCol[k]} = $${params.length}::jsonb`); }
    }
    if (!sets.length) return this.getScenarioBySlug(slug);
    sets.push('updated_at = now()');
    params.push(slug);
    const { rows } = await this.pool.query(`UPDATE scenario SET ${sets.join(', ')} WHERE slug = $${params.length} RETURNING *`, params);
    return rows[0] ? rowToScenario(rows[0]) : null;
  }

  async deleteScenario(slug: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM scenario WHERE slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  }

  async upsertScenarioFromCompile(
    rec: CompiledScenarioRecord,
    source: { repoPath: string; contentHash: string; revision: string | null },
  ): Promise<{ scenario: ScenarioRecord; source: ContentSourceRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT id FROM scenario WHERE slug = $1', [rec.slug]);
      const created = before.rowCount === 0;
      const { rows } = await client.query(
        `INSERT INTO scenario (slug, name, description, ai_instructions, rubric, is_public, voice_name, language_code, tools, metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, ai_instructions = EXCLUDED.ai_instructions,
           rubric = EXCLUDED.rubric, is_public = EXCLUDED.is_public, voice_name = EXCLUDED.voice_name,
           language_code = EXCLUDED.language_code, tools = EXCLUDED.tools, metadata = EXCLUDED.metadata,
           updated_at = now()
         RETURNING *`,
        [rec.slug, rec.name, rec.description, rec.aiInstructions, JSON.stringify(rec.rubric), rec.isPublic,
          rec.voiceName, rec.languageCode, JSON.stringify(rec.tools), JSON.stringify(rec.metadata)],
      );
      const scenario = rowToScenario(rows[0]);
      const sres = await client.query(
        `INSERT INTO content_source (entity_type, entity_id, repo_path, content_hash, revision)
         VALUES ('scenario', $1, $2, $3, $4)
         ON CONFLICT (entity_type, entity_id) DO UPDATE SET
           repo_path = EXCLUDED.repo_path, content_hash = EXCLUDED.content_hash,
           revision = EXCLUDED.revision, compiled_at = now()
         RETURNING *`,
        [scenario.id, source.repoPath, source.contentHash, source.revision],
      );
      await client.query('COMMIT');
      const sr = sres.rows[0];
      return {
        scenario,
        created,
        source: {
          entityType: 'scenario', entityId: scenario.id, repoPath: sr.repo_path,
          contentHash: sr.content_hash, revision: sr.revision ?? null,
          compiledAt: new Date(sr.compiled_at).toISOString(),
        },
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getContentSource(entityType: ContentEntityType, entityId: string): Promise<ContentSourceRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM content_source WHERE entity_type = $1 AND entity_id = $2', [entityType, entityId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      entityType: r.entity_type, entityId: r.entity_id, repoPath: r.repo_path,
      contentHash: r.content_hash, revision: r.revision ?? null,
      compiledAt: new Date(r.compiled_at).toISOString(),
    };
  }

  async createSession(input: NewSession): Promise<SessionRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO session (scenario_id, user_id, coach_id, course_id, vendor, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [input.scenarioId, input.userId ?? null, input.coachId ?? null, input.courseId ?? null, input.vendor],
    );
    return rowToSession(rows[0]);
  }

  async appendSessionEvent(row: SessionEventRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_event (session_id, ts, type, payload) VALUES ($1, to_timestamp($2/1000.0), $3, $4::jsonb)`,
      [row.sessionId, row.ts, row.type, JSON.stringify(row.payload)],
    );
  }

  async completeSession(
    sessionId: string,
    update: { status: 'completed' | 'failed'; endedAt: number; transcript: SessionTranscript },
  ): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query(
      `UPDATE session SET status = $2, ended_at = to_timestamp($3/1000.0), transcript = $4::jsonb WHERE id = $1 RETURNING *`,
      [sessionId, update.status, update.endedAt, JSON.stringify(update.transcript)],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM session WHERE id = $1', [id]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async listSessionsByScenario(scenarioId: string): Promise<SessionRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM session WHERE scenario_id = $1 ORDER BY started_at DESC', [scenarioId]);
    return rows.map(rowToSession);
  }

  async listSessionsByCourse(courseId: string): Promise<SessionRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM session WHERE course_id = $1 ORDER BY started_at DESC', [courseId]);
    return rows.map(rowToSession);
  }

  async listSessionsByCoachUser(coachId: string, userId: string): Promise<SessionRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM session WHERE coach_id = $1 AND user_id = $2 ORDER BY started_at DESC',
      [coachId, userId],
    );
    return rows.map(rowToSession);
  }

  async listSessionEvents(sessionId: string): Promise<SessionEventRow[]> {
    const { rows } = await this.pool.query('SELECT * FROM session_event WHERE session_id = $1 ORDER BY ts', [sessionId]);
    return rows.map((r: Row) => ({ sessionId: r.session_id, ts: new Date(r.ts).getTime(), type: r.type, payload: r.payload ?? {} }));
  }

  async recordVoiceUsage(u: VoiceUsageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO voice_usage (session_id, user_id, scenario_id, vendor, model, duration_ms, voice_minutes,
        input_text_tokens, input_audio_tokens, cached_text_tokens, cached_audio_tokens,
        output_text_tokens, output_audio_tokens, total_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (session_id) DO NOTHING`,
      [u.sessionId, u.userId ?? null, u.scenarioId, u.vendor, u.model, u.durationMs, u.voiceMinutes,
        u.inputTextTokens, u.inputAudioTokens, u.cachedTextTokens, u.cachedAudioTokens,
        u.outputTextTokens, u.outputAudioTokens, u.totalTokens],
    );
  }

  async getVoiceUsage(sessionId: string): Promise<VoiceUsageRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM voice_usage WHERE session_id = $1', [sessionId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      sessionId: r.session_id, userId: r.user_id ?? null, scenarioId: r.scenario_id, vendor: r.vendor,
      model: r.model ?? null, durationMs: Number(r.duration_ms), voiceMinutes: Number(r.voice_minutes),
      inputTextTokens: Number(r.input_text_tokens), inputAudioTokens: Number(r.input_audio_tokens),
      cachedTextTokens: Number(r.cached_text_tokens), cachedAudioTokens: Number(r.cached_audio_tokens),
      outputTextTokens: Number(r.output_text_tokens), outputAudioTokens: Number(r.output_audio_tokens),
      totalTokens: Number(r.total_tokens),
    };
  }

  // ── Coach CRUD ──────────────────────────────────────────────────────────────
  async listCoaches(): Promise<CoachRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM coach ORDER BY created_at DESC');
    return rows.map(rowToCoach);
  }

  async getCoachBySlug(slug: string): Promise<CoachRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM coach WHERE slug = $1', [slug]);
    return rows[0] ? rowToCoach(rows[0]) : null;
  }

  async getCoachById(id: string): Promise<CoachRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM coach WHERE id = $1', [id]);
    return rows[0] ? rowToCoach(rows[0]) : null;
  }

  async deleteCoach(slug: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM coach WHERE slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  }

  async upsertCoachFromCompile(
    rec: CompiledCoachRecord,
    source: ContentSourceInput,
  ): Promise<{ coach: CoachRecord; source: ContentSourceRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let scenarioId: string | null = null;
      if (rec.scenarioRef) {
        const sc = await client.query('SELECT id FROM scenario WHERE slug = $1', [rec.scenarioRef]);
        if (!sc.rows[0]) throw new Error(`coach "${rec.slug}" references unknown scenario "${rec.scenarioRef}"`);
        scenarioId = sc.rows[0].id;
      }
      const before = await client.query('SELECT id FROM coach WHERE slug = $1', [rec.slug]);
      const created = before.rowCount === 0;
      const { rows } = await client.query(
        `INSERT INTO coach (slug, name, scenario_id, inline_ai_instructions, memory_scope, retention, schedule)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, scenario_id = EXCLUDED.scenario_id,
           inline_ai_instructions = EXCLUDED.inline_ai_instructions,
           memory_scope = EXCLUDED.memory_scope, retention = EXCLUDED.retention,
           schedule = EXCLUDED.schedule, updated_at = now()
         RETURNING *`,
        [rec.slug, rec.name, scenarioId, rec.inlineAiInstructions, rec.memoryScope, rec.retention,
          JSON.stringify(rec.schedule)],
      );
      const coach = rowToCoach(rows[0]);
      const src = await upsertContentSource(client, 'coach', coach.id, source);
      await client.query('COMMIT');
      return { coach, source: src, created };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Course CRUD ───────────────────────────────────────────────────────────────
  async listCourses(): Promise<CourseRecord[]> {
    const { rows } = await this.pool.query(`${COURSE_SELECT} ORDER BY c.created_at DESC`);
    return rows.map(rowToCourse);
  }

  async getCourseBySlug(slug: string): Promise<CourseRecord | null> {
    const { rows } = await this.pool.query(`${COURSE_SELECT} WHERE c.slug = $1`, [slug]);
    return rows[0] ? rowToCourse(rows[0]) : null;
  }

  async getCourseById(id: string): Promise<CourseRecord | null> {
    const { rows } = await this.pool.query(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    return rows[0] ? rowToCourse(rows[0]) : null;
  }

  async deleteCourse(slug: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM course WHERE slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  }

  async upsertCourseFromCompile(
    rec: CompiledCourseRecord,
    source: ContentSourceInput,
  ): Promise<{ course: CourseRecord; source: ContentSourceRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scenarioIds: string[] = [];
      for (const ref of rec.scenarioRefs) {
        const sc = await client.query('SELECT id FROM scenario WHERE slug = $1', [ref]);
        if (!sc.rows[0]) throw new Error(`course "${rec.slug}" references unknown scenario "${ref}"`);
        scenarioIds.push(sc.rows[0].id);
      }
      let coachId: string | null = null;
      if (rec.coachRef) {
        const co = await client.query('SELECT id FROM coach WHERE slug = $1', [rec.coachRef]);
        if (!co.rows[0]) throw new Error(`course "${rec.slug}" references unknown coach "${rec.coachRef}"`);
        coachId = co.rows[0].id;
      }
      const before = await client.query('SELECT id FROM course WHERE slug = $1', [rec.slug]);
      const created = before.rowCount === 0;
      const { rows } = await client.query(
        `INSERT INTO course (slug, name, visibility, coach_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, visibility = EXCLUDED.visibility, coach_id = EXCLUDED.coach_id,
           updated_at = now()
         RETURNING id`,
        [rec.slug, rec.name, rec.isPublic ? 'public' : 'private', coachId],
      );
      const courseId = rows[0].id as string;
      // Replace the ordered join wholesale (positions are authoritative from the file).
      await client.query('DELETE FROM course_scenario WHERE course_id = $1', [courseId]);
      for (let i = 0; i < scenarioIds.length; i++) {
        await client.query(
          'INSERT INTO course_scenario (course_id, scenario_id, position) VALUES ($1,$2,$3)',
          [courseId, scenarioIds[i], i],
        );
      }
      const src = await upsertContentSource(client, 'course', courseId, source);
      await client.query('COMMIT');
      const course = await this.getCourseById(courseId);
      return { course: course!, source: src, created };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Coach memory (ADR-004) — every query runs inside an RLS transaction ─────
  /**
   * Run `fn` in a transaction with `app.user_id` set, so the mandated RLS policy
   * on `coach_memory` (ADR-004) scopes every row to the authenticated user. This
   * is the single tenancy-enforcing access path — no ad-hoc raw memory queries.
   */
  private async withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async writeCoachMemory(rec: NewCoachMemory): Promise<CoachMemoryRecord> {
    return this.withUser(rec.userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO coach_memory (coach_id, user_id, kind, content, embedding, source_session_id, salience, expires_at)
         VALUES ($1,$2,$3,$4,$5::vector,$6,$7,$8) RETURNING *`,
        [rec.coachId, rec.userId, rec.kind, rec.content, toVectorLiteral(rec.embedding),
          rec.sourceSessionId, rec.salience, rec.expiresAt],
      );
      return rowToMemory(rows[0]);
    });
  }

  async listCoachMemory(coachId: string, userId: string): Promise<CoachMemoryRecord[]> {
    return this.withUser(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM coach_memory WHERE coach_id = $1 AND user_id = $2 AND expires_at > now()
         ORDER BY created_at DESC`,
        [coachId, userId],
      );
      return rows.map(rowToMemory);
    });
  }

  async bumpCoachMemoryExpiry(ids: string[], userId: string, expiresAt: string): Promise<void> {
    if (!ids.length) return;
    await this.withUser(userId, async (client) => {
      await client.query('UPDATE coach_memory SET expires_at = $2 WHERE id = ANY($1::uuid[])', [ids, expiresAt]);
    });
  }

  async deleteCoachMemory(coachId: string, userId: string, memoryId: string): Promise<boolean> {
    return this.withUser(userId, async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM coach_memory WHERE id = $1 AND coach_id = $2 AND user_id = $3',
        [memoryId, coachId, userId],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async wipeCoachMemory(coachId: string, userId: string): Promise<number> {
    return this.withUser(userId, async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM coach_memory WHERE coach_id = $1 AND user_id = $2',
        [coachId, userId],
      );
      return rowCount ?? 0;
    });
  }

  // ── Consent + audit (ADR-004) ───────────────────────────────────────────────
  async recordConsent(rec: NewConsent): Promise<ConsentRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO consent_record (user_id, scope, consent_type, action, policy_version, policy_text_hash, locale, ui_surface)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [rec.userId, rec.scope, rec.consentType, rec.action, rec.policyVersion ?? null,
        rec.policyTextHash ?? null, rec.locale ?? null, rec.uiSurface ?? null],
    );
    return rowToConsent(rows[0]);
  }

  async getConsentState(userId: string, scope: string): Promise<ConsentState> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (consent_type) consent_type, action
       FROM consent_record WHERE user_id = $1 AND scope = $2
       ORDER BY consent_type, created_at DESC`,
      [userId, scope],
    );
    const state: ConsentState = { persistentMemory: false, audioRetention: false };
    for (const r of rows) {
      const granted = r.action === 'granted';
      if (r.consent_type === 'persistent_memory') state.persistentMemory = granted;
      if (r.consent_type === 'audio_retention') state.audioRetention = granted;
    }
    return state;
  }

  async listConsent(userId: string, scope: string): Promise<ConsentRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM consent_record WHERE user_id = $1 AND scope = $2 ORDER BY created_at DESC',
      [userId, scope],
    );
    return rows.map(rowToConsent);
  }

  async recordAuditEvent(ev: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (actor, event, subject_user_id, coach_id, refs) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [ev.actor, ev.event, ev.subjectUserId, ev.coachId, JSON.stringify(ev.refs)],
    );
  }

  async listAuditEvents(subjectUserId: string): Promise<(AuditEvent & { ts: string })[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM audit_log WHERE subject_user_id = $1 ORDER BY ts DESC',
      [subjectUserId],
    );
    return rows.map((r: Row) => ({
      actor: r.actor, event: r.event, subjectUserId: r.subject_user_id ?? null,
      coachId: r.coach_id ?? null, refs: (r.refs ?? {}) as Record<string, unknown>,
      ts: new Date(r.ts).toISOString(),
    }));
  }
}

// Shared course SELECT: aggregates the ordered scenario ids from the join.
const COURSE_SELECT = `
  SELECT c.*,
         COALESCE((SELECT array_agg(cs.scenario_id ORDER BY cs.position)
                   FROM course_scenario cs WHERE cs.course_id = c.id), '{}') AS scenario_ids
  FROM course c`;

function rowToCourse(r: Row): CourseRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    isPublic: r.visibility === 'public',
    coachId: r.coach_id ?? null,
    scenarioIds: (r.scenario_ids ?? []) as string[],
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function rowToConsent(r: Row): ConsentRecord {
  return {
    id: r.id,
    userId: r.user_id,
    scope: r.scope,
    consentType: r.consent_type,
    action: r.action,
    policyVersion: r.policy_version ?? null,
    policyTextHash: r.policy_text_hash ?? null,
    locale: r.locale ?? null,
    uiSurface: r.ui_surface ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Upsert a content_source row inside an existing transaction (shared by coach/course). */
async function upsertContentSource(
  client: PoolClient,
  entityType: ContentEntityType,
  entityId: string,
  source: ContentSourceInput,
): Promise<ContentSourceRecord> {
  const { rows } = await client.query(
    `INSERT INTO content_source (entity_type, entity_id, repo_path, content_hash, revision)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       repo_path = EXCLUDED.repo_path, content_hash = EXCLUDED.content_hash,
       revision = EXCLUDED.revision, compiled_at = now()
     RETURNING *`,
    [entityType, entityId, source.repoPath, source.contentHash, source.revision],
  );
  const r = rows[0];
  return {
    entityType: r.entity_type, entityId: r.entity_id, repoPath: r.repo_path,
    contentHash: r.content_hash, revision: r.revision ?? null,
    compiledAt: new Date(r.compiled_at).toISOString(),
  };
}
