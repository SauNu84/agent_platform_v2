/**
 * Postgres Store implementation (production). Backed by db/migrations/0001.
 * Uses a single pooled connection; jsonb columns map to/from the TS shapes.
 */
import { Pool } from 'pg';
import type { CompiledScenarioRecord, RubricItem, ScenarioRecord } from '@/domain/scenario';
import type { ToolDefinition } from '@/voice/realtime-interface';
import type {
  ContentSourceRecord, NewSession, ScenarioFilter, SessionEventRow, SessionRecord,
  SessionTranscript, Store, VoiceUsageRecord,
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
    vendor: r.vendor,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    transcript: (r.transcript ?? null) as SessionTranscript | null,
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

  async getContentSource(entityType: 'scenario' | 'coach' | 'course', entityId: string): Promise<ContentSourceRecord | null> {
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
      `INSERT INTO session (scenario_id, user_id, vendor, status) VALUES ($1,$2,$3,'active') RETURNING *`,
      [input.scenarioId, input.userId ?? null, input.vendor],
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
}
