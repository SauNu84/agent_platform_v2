/**
 * Postgres Store implementation (production). Backed by db/migrations/0001-0005.
 * Uses a single pooled connection; jsonb columns map to/from the TS shapes.
 *
 * RLS (Slice 5, SAU-229): scenario/coach/course/session enforce ownership via
 * Postgres Row-Level Security (migration 0005), the same backstop coach_memory
 * has used since 0003. The policies read two GUCs — `app.user_id` and
 * `app.is_admin`. Rather than thread a user through every method, the auth layer
 * binds the acting user into a request-scoped AsyncLocalStorage (src/auth/actor),
 * and every query here runs through `q()`/`withActorTx()`, which open a
 * transaction and `SET LOCAL` those GUCs from the bound actor. No actor bound
 * (anonymous request, share-link path) → queries run on the pool with no GUC, so
 * the policies expose public/null-owner rows only.
 */
import { Pool, PoolClient, QueryResult } from 'pg';
import type { CompiledScenarioRecord, KnowledgeBaseDoc, RubricItem, ScenarioRecord } from '@/domain/scenario';
import type { AnalysisRecord, Evaluation, Improvement } from '@/domain/analysis';
import type { ToolDefinition } from '@/voice/realtime-interface';
import type { CoachRecord, CompiledCoachRecord, CoachSchedule } from '@/domain/coach';
import type { CourseRecord, CompiledCourseRecord } from '@/domain/course';
import type {
  ApiKeyRecord, AuditEvent, AuthSessionRecord, CheckoutRecord, ClinicNotificationRecord, ClinicOutcomeRecord, ClinicOutcomeSummary, ClinicRecord, NewClinic, CoachMemoryRecord, ConsentRecord, ConsentState, ContentEntityType,
  ContentSourceInput, ContentSourceRecord, CreatorAnalyticsRow, EntitlementRecord,
  KnowledgeBaseRecord, KnowledgeBaseDocRecord, NewKnowledgeBase, NewKnowledgeBaseDoc,
  NewAnalysis, NewCoachMemory, NewConsent, NewSession, NewUser, OwnerOpts, ScenarioFilter,
  SessionEventRow, SessionHistoryRow, SessionRecord, SessionTranscript, ShareLinkRecord, Store,
  UserRecord, UserSettingRecord, VoiceUsageRecord, VoiceUsageByTierRow, WebhookRecord,
  PhiAccessInput, PhiAccessRecord, PhiAccessFilter,
} from './store';
import type {
  Debtor, DebtorPii, NewDebtor, CollectionsAuditInput, CollectionsAuditRecord, CollectionsAuditFilter,
} from '@/domain/collections';
import type { NewCallAttempt, CallAttemptRecord } from '@/domain/collections-outcome';
import { outcomeHadConversation } from '@/domain/collections-outcome';
import { genShareCode } from '@/lib/short-code';
import { encryptJson, decryptJson } from '@/lib/phi';
import { phiAuditIntegrity } from '@/lib/phi-audit';
import { collectionsAuditIntegrity } from '@/domain/collections-audit';
import { getActorContext } from '@/auth/actor';

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
    ownerUserId: r.owner_user_id ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function rowToClinicOutcome(r: Row): ClinicOutcomeRecord {
  return {
    sessionId: r.session_id,
    scenarioId: r.scenario_id,
    userId: r.user_id ?? null,
    clinicId: r.clinic_id ?? null,
    outcome: r.outcome,
    eventId: r.event_id ?? null,
    eventLink: r.event_link ?? null,
    doctorId: r.doctor_id ?? null,
    doctorName: r.doctor_name ?? null,
    slotStart: r.slot_start ? new Date(r.slot_start).toISOString() : null,
    slotEnd: r.slot_end ? new Date(r.slot_end).toISOString() : null,
    calendar: r.calendar ?? null,
    simulated: r.simulated ?? true,
    // PHI at rest (SAU-274): `intake` is stored as an AES-256-GCM envelope; decrypt
    // on read. Legacy pre-0017 plaintext rows pass through unchanged.
    intake: decryptJson<Record<string, unknown>>(r.intake) ?? {},
    escalationReason: r.escalation_reason ?? null,
    handoffAction: r.handoff_action ?? null,
    confirmationStatus: r.confirmation_status ?? null,
    afterHours: r.after_hours ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
  };
}

function rowToClinicNotification(r: Row): ClinicNotificationRecord {
  return {
    id: r.id,
    sessionId: r.session_id ?? null,
    userId: r.user_id ?? null,
    clinicId: r.clinic_id ?? null,
    reference: r.reference,
    channel: r.channel,
    audience: r.audience,
    recipientMasked: r.recipient_masked,
    status: r.status,
    providerId: r.provider_id ?? null,
    simulated: r.simulated ?? true,
    error: r.error ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
  };
}

function rowToClinic(r: Row): ClinicRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    config: r.config ?? null,
    createdByUserId: r.created_by_user_id ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date(0).toISOString(),
  };
}

function rowToSession(r: Row): SessionRecord {
  return {
    id: r.id,
    userId: r.user_id ?? null,
    clinicId: r.clinic_id ?? null,
    scenarioId: r.scenario_id,
    coachId: r.coach_id ?? null,
    courseId: r.course_id ?? null,
    vendor: r.vendor,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    // PHI at rest (SAU-274): the call transcript is stored as an AES-256-GCM
    // envelope; decrypt on read. Legacy pre-0017 plaintext rows pass through.
    transcript: decryptJson<SessionTranscript | null>(r.transcript ?? null),
  };
}

function rowToAnalysis(r: Row): AnalysisRecord {
  const reportCard = (r.report_card ?? []) as Evaluation['reportCard'];
  const improvement = (r.improvement ?? {}) as Partial<Improvement>;
  return {
    sessionId: r.session_id,
    scenarioId: r.scenario_id,
    userId: r.user_id ?? null,
    scorer: r.scorer,
    overallScore: Number(r.overall_score),
    evaluation: {
      reportCard,
      finalScore: Number(r.final_score),
      strengths: (r.strengths ?? []) as string[],
      weaknesses: (r.weaknesses ?? []) as string[],
    },
    improvement: { areas: improvement.areas ?? [], actionItems: improvement.actionItems ?? [] },
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
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
    ownerUserId: r.owner_user_id ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function rowToUser(r: Row): UserRecord {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    displayName: r.display_name,
    clinicId: r.clinic_id ?? null,
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

function rowToPhiAccess(r: Row): PhiAccessRecord {
  return {
    id: r.id,
    seq: Number(r.seq),
    ts: new Date(r.ts).toISOString(),
    actorUserId: r.actor_user_id ?? null,
    actorLabel: r.actor_label,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id ?? null,
    clinicId: r.clinic_id ?? null,
    refs: (r.refs ?? {}) as Record<string, unknown>,
    integrity: r.integrity,
  };
}

function rowToDebtor(r: Row): Debtor {
  // PII lives in one AES-256-GCM envelope at rest (SAU-274 lib/phi); decrypt in-process.
  const pii = decryptJson<DebtorPii>(r.pii) ?? { name: '', phone: '', balanceCents: 0 };
  return {
    id: r.id,
    clinicId: r.clinic_id,
    externalRef: r.external_ref,
    name: pii.name,
    phone: pii.phone,
    balanceCents: pii.balanceCents,
    timezone: r.timezone,
    state: r.state ?? null,
    consent: Boolean(r.consent),
    optedOut: Boolean(r.opted_out),
    optedOutAt: r.opted_out_at ? new Date(r.opted_out_at).toISOString() : null,
    disputeOpen: Boolean(r.dispute_open),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function rowToCollectionsAudit(r: Row): CollectionsAuditRecord {
  return {
    id: r.id,
    seq: Number(r.seq),
    ts: new Date(r.ts).toISOString(),
    clinicId: r.clinic_id,
    actorUserId: r.actor_user_id ?? null,
    actorLabel: r.actor_label,
    debtorRef: r.debtor_ref,
    eventType: r.event_type,
    decision: r.decision ?? null,
    reason: r.reason ?? null,
    refs: (r.refs ?? {}) as Record<string, unknown>,
    prevIntegrity: r.prev_integrity ?? '',
    integrity: r.integrity,
  };
}

function rowToCallAttempt(r: Row): CallAttemptRecord {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    debtorId: r.debtor_id,
    outcome: r.outcome,
    hadConversation: Boolean(r.had_conversation),
    blockReason: r.block_reason ?? null,
    attemptedAt: new Date(r.attempted_at).toISOString(),
    simulated: Boolean(r.simulated),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rowToShareLink(r: Row): ShareLinkRecord {
  return { code: r.code, scenarioId: r.scenario_id, createdAt: new Date(r.created_at).toISOString() };
}

function rowToCheckout(r: Row): CheckoutRecord {
  return {
    id: r.id,
    userId: r.user_id,
    planId: r.plan_id,
    billingCycle: r.billing_cycle,
    provider: r.provider,
    amountCents: Number(r.amount_cents),
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rowToApiKey(r: Row): ApiKeyRecord {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    keyPrefix: r.key_prefix,
    keyHash: r.key_hash,
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rowToWebhook(r: Row): WebhookRecord {
  return {
    id: r.id,
    userId: r.user_id,
    url: r.url,
    secret: r.secret,
    events: Array.isArray(r.events) ? r.events : [],
    enabled: Boolean(r.enabled),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rowToUserSetting(r: Row): UserSettingRecord {
  return {
    key: r.key,
    value: (r.value ?? {}) as Record<string, unknown>,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function rowToKnowledgeBase(r: Row): KnowledgeBaseRecord {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    ownerUserId: r.owner_user_id ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    docCount: Number(r.doc_count ?? 0),
  };
}

function rowToKbDoc(r: Row): KnowledgeBaseDocRecord {
  return {
    id: r.id,
    kbId: r.kb_id,
    filename: r.filename,
    contentType: r.content_type,
    extractedText: r.extracted_text ?? '',
    chars: Number(r.chars ?? 0),
    byteSize: Number(r.byte_size ?? 0),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export class PgStore implements Store {
  constructor(private pool: Pool) {}

  // ── RLS plumbing ─────────────────────────────────────────────────────────
  /** Apply the request-scoped actor's GUCs (transaction-local) for RLS. */
  private async applyActor(client: PoolClient): Promise<void> {
    const ctx = getActorContext();
    // app.clinic_id (SAU-275) drives the multi-clinic PHI policies; '' (unset) for
    // platform/consumer users so the clinic clause simply never matches.
    await client.query('SELECT set_config($1,$2,true), set_config($3,$4,true), set_config($5,$6,true)', [
      'app.user_id', ctx?.userId ?? '',
      'app.is_admin', ctx?.isAdmin ? 'on' : 'off',
      'app.clinic_id', ctx?.clinicId ?? '',
    ]);
  }

  /** Run `fn` in a transaction with the actor GUCs set (for RLS-scoped work). */
  private async withActorTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyActor(client);
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

  /**
   * RLS-aware query: if an actor is bound for this request, run inside a
   * transaction with the GUCs set so policies see the user; otherwise hit the
   * pool directly (anonymous → public-only reads, ownership writes rejected).
   */
  private q(text: string, params?: unknown[]): Promise<QueryResult> {
    if (getActorContext()) return this.withActorTx((c) => c.query(text, params));
    return this.pool.query(text, params);
  }

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
    const { rows } = await this.q(`SELECT * FROM scenario ${where} ORDER BY created_at DESC`, params);
    return rows.map(rowToScenario);
  }

  async getScenarioBySlug(slug: string): Promise<ScenarioRecord | null> {
    const { rows } = await this.q('SELECT * FROM scenario WHERE slug = $1', [slug]);
    return rows[0] ? rowToScenario(rows[0]) : null;
  }

  async getScenarioById(id: string): Promise<ScenarioRecord | null> {
    const { rows } = await this.q('SELECT * FROM scenario WHERE id = $1', [id]);
    return rows[0] ? rowToScenario(rows[0]) : null;
  }

  async createScenario(rec: CompiledScenarioRecord, owner?: OwnerOpts): Promise<ScenarioRecord> {
    const { rows } = await this.q(
      `INSERT INTO scenario (slug, name, description, ai_instructions, rubric, is_public, voice_name, language_code, tools, metadata, owner_user_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11) RETURNING *`,
      [rec.slug, rec.name, rec.description, rec.aiInstructions, JSON.stringify(rec.rubric), rec.isPublic,
        rec.voiceName, rec.languageCode, JSON.stringify(rec.tools), JSON.stringify(rec.metadata),
        owner?.ownerUserId ?? null],
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
    const { rows } = await this.q(`UPDATE scenario SET ${sets.join(', ')} WHERE slug = $${params.length} RETURNING *`, params);
    return rows[0] ? rowToScenario(rows[0]) : null;
  }

  async deleteScenario(slug: string): Promise<boolean> {
    const { rowCount } = await this.q('DELETE FROM scenario WHERE slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  }

  async upsertScenarioFromCompile(
    rec: CompiledScenarioRecord,
    source: { repoPath: string; contentHash: string; revision: string | null },
    owner?: OwnerOpts,
  ): Promise<{ scenario: ScenarioRecord; source: ContentSourceRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyActor(client);
      const before = await client.query('SELECT id FROM scenario WHERE slug = $1', [rec.slug]);
      const created = before.rowCount === 0;
      const { rows } = await client.query(
        `INSERT INTO scenario (slug, name, description, ai_instructions, rubric, is_public, voice_name, language_code, tools, metadata, owner_user_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, ai_instructions = EXCLUDED.ai_instructions,
           rubric = EXCLUDED.rubric, is_public = EXCLUDED.is_public, voice_name = EXCLUDED.voice_name,
           language_code = EXCLUDED.language_code, tools = EXCLUDED.tools, metadata = EXCLUDED.metadata,
           updated_at = now()
         RETURNING *`,
        [rec.slug, rec.name, rec.description, rec.aiInstructions, JSON.stringify(rec.rubric), rec.isPublic,
          rec.voiceName, rec.languageCode, JSON.stringify(rec.tools), JSON.stringify(rec.metadata),
          owner?.ownerUserId ?? null],
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
    const { rows } = await this.q('SELECT * FROM content_source WHERE entity_type = $1 AND entity_id = $2', [entityType, entityId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      entityType: r.entity_type, entityId: r.entity_id, repoPath: r.repo_path,
      contentHash: r.content_hash, revision: r.revision ?? null,
      compiledAt: new Date(r.compiled_at).toISOString(),
    };
  }

  // ── Share links (SAU-225) ────────────────────────────────────────────────────
  async createShareLink(scenarioId: string): Promise<ShareLinkRecord> {
    // Idempotent per scenario: the UNIQUE (scenario_id) constraint makes the
    // INSERT a no-op on re-share; we then read back the existing (or just-created)
    // row, so the same scenario always yields the same code.
    const code = genShareCode();
    const { rows } = await this.q(
      `INSERT INTO share_link (code, scenario_id) VALUES ($1, $2)
       ON CONFLICT (scenario_id) DO NOTHING
       RETURNING *`,
      [code, scenarioId],
    );
    if (rows[0]) return rowToShareLink(rows[0]);
    const existing = await this.q('SELECT * FROM share_link WHERE scenario_id = $1', [scenarioId]);
    return rowToShareLink(existing.rows[0]);
  }

  async getShareLinkByCode(code: string): Promise<ShareLinkRecord | null> {
    const { rows } = await this.q('SELECT * FROM share_link WHERE code = $1', [code]);
    return rows[0] ? rowToShareLink(rows[0]) : null;
  }

  // ── Knowledge Base (SAU-243) — migration 0008 ──────────────────────────────
  async createKnowledgeBase(input: NewKnowledgeBase, owner?: OwnerOpts): Promise<KnowledgeBaseRecord> {
    const { rows } = await this.q(
      `INSERT INTO knowledge_base (title, description, owner_user_id) VALUES ($1,$2,$3) RETURNING *`,
      [input.title, input.description ?? null, owner?.ownerUserId ?? null],
    );
    return rowToKnowledgeBase({ ...rows[0], doc_count: 0 });
  }

  async listKnowledgeBases(): Promise<KnowledgeBaseRecord[]> {
    const { rows } = await this.q(
      `SELECT kb.*, COUNT(d.id) AS doc_count
       FROM knowledge_base kb LEFT JOIN knowledge_base_document d ON d.kb_id = kb.id
       GROUP BY kb.id ORDER BY kb.created_at DESC`,
    );
    return rows.map(rowToKnowledgeBase);
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBaseRecord | null> {
    const { rows } = await this.q(
      `SELECT kb.*, COUNT(d.id) AS doc_count
       FROM knowledge_base kb LEFT JOIN knowledge_base_document d ON d.kb_id = kb.id
       WHERE kb.id = $1 GROUP BY kb.id`,
      [id],
    );
    return rows[0] ? rowToKnowledgeBase(rows[0]) : null;
  }

  async deleteKnowledgeBase(id: string): Promise<boolean> {
    // documents + join rows cascade (FK ON DELETE CASCADE in migration 0008).
    const { rowCount } = await this.q('DELETE FROM knowledge_base WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async addKnowledgeBaseDocument(doc: NewKnowledgeBaseDoc): Promise<KnowledgeBaseDocRecord> {
    return this.withActorTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO knowledge_base_document (kb_id, filename, content_type, extracted_text, chars, byte_size)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [doc.kbId, doc.filename, doc.contentType, doc.extractedText, doc.extractedText.length, doc.byteSize],
      );
      await c.query('UPDATE knowledge_base SET updated_at = now() WHERE id = $1', [doc.kbId]);
      return rowToKbDoc(rows[0]);
    });
  }

  async listKnowledgeBaseDocuments(kbId: string): Promise<KnowledgeBaseDocRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM knowledge_base_document WHERE kb_id = $1 ORDER BY created_at ASC, id ASC',
      [kbId],
    );
    return rows.map(rowToKbDoc);
  }

  async linkScenarioKnowledgeBase(scenarioId: string, kbId: string): Promise<void> {
    await this.q(
      `INSERT INTO scenario_knowledge_base (scenario_id, kb_id) VALUES ($1,$2)
       ON CONFLICT (scenario_id, kb_id) DO NOTHING`,
      [scenarioId, kbId],
    );
  }

  async unlinkScenarioKnowledgeBase(scenarioId: string, kbId: string): Promise<boolean> {
    const { rowCount } = await this.q(
      'DELETE FROM scenario_knowledge_base WHERE scenario_id = $1 AND kb_id = $2',
      [scenarioId, kbId],
    );
    return (rowCount ?? 0) > 0;
  }

  async listScenarioKnowledgeBases(scenarioId: string): Promise<KnowledgeBaseRecord[]> {
    const { rows } = await this.q(
      `SELECT kb.*, COUNT(d.id) AS doc_count
       FROM scenario_knowledge_base skb
       JOIN knowledge_base kb ON kb.id = skb.kb_id
       LEFT JOIN knowledge_base_document d ON d.kb_id = kb.id
       WHERE skb.scenario_id = $1
       GROUP BY kb.id, skb.created_at ORDER BY skb.created_at ASC`,
      [scenarioId],
    );
    return rows.map(rowToKnowledgeBase);
  }

  async listKnowledgeForScenario(scenarioId: string): Promise<KnowledgeBaseDoc[]> {
    // Deterministic injection order: link order (skb.created_at), then per-KB
    // upload order (doc.created_at). Open SELECT policy (migration 0008) lets
    // this run for any session-runner, not just the owner.
    const { rows } = await this.q(
      `SELECT d.filename, d.extracted_text
       FROM scenario_knowledge_base skb
       JOIN knowledge_base_document d ON d.kb_id = skb.kb_id
       WHERE skb.scenario_id = $1 AND length(btrim(d.extracted_text)) > 0
       ORDER BY skb.created_at ASC, skb.kb_id ASC, d.created_at ASC, d.id ASC`,
      [scenarioId],
    );
    return rows.map((r) => ({ filename: r.filename, text: r.extracted_text }));
  }

  async createSession(input: NewSession): Promise<SessionRecord> {
    const { rows } = await this.q(
      `INSERT INTO session (scenario_id, user_id, coach_id, course_id, vendor, status, clinic_id)
       VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
      [input.scenarioId, input.userId ?? null, input.coachId ?? null, input.courseId ?? null, input.vendor,
        input.clinicId ?? null],
    );
    return rowToSession(rows[0]);
  }

  async appendSessionEvent(row: SessionEventRow): Promise<void> {
    await this.q(
      `INSERT INTO session_event (session_id, ts, type, payload) VALUES ($1, to_timestamp($2/1000.0), $3, $4::jsonb)`,
      // PHI at rest (SAU-274): event payloads carry live transcript text — encrypt.
      [row.sessionId, row.ts, row.type, JSON.stringify(encryptJson(row.payload))],
    );
    // PHI audit (SAU-275): a live transcript/tool-call event is PHI — record it.
    // This is the PROGRAMMATIC-AGENT write path during a call; the bound actor
    // (e.g. agent:<scenario>) names the principal.
    await this.recordPhiAccess({
      action: 'write', entity: 'session_event.payload', entityId: row.sessionId, refs: { type: row.type },
    });
  }

  async completeSession(
    sessionId: string,
    update: { status: 'completed' | 'failed'; startedAt?: number; endedAt: number; transcript: SessionTranscript },
  ): Promise<SessionRecord | null> {
    // COALESCE keeps the existing started_at when the caller doesn't supply one.
    const { rows } = await this.q(
      `UPDATE session SET status = $2,
         started_at = COALESCE(to_timestamp($5/1000.0), started_at),
         ended_at = to_timestamp($3/1000.0), transcript = $4::jsonb
       WHERE id = $1 RETURNING *`,
      // PHI at rest (SAU-274): encrypt the transcript into an envelope before write.
      [sessionId, update.status, update.endedAt, JSON.stringify(encryptJson(update.transcript)), update.startedAt ?? null],
    );
    if (!rows[0]) return null;
    // PHI audit (SAU-275): the call transcript is PHI — record the write.
    await this.recordPhiAccess({
      action: 'write', entity: 'session.transcript', entityId: sessionId,
      clinicId: rows[0].clinic_id ?? null, refs: { turns: update.transcript?.turns?.length ?? 0 },
    });
    return rowToSession(rows[0]);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.q('SELECT * FROM session WHERE id = $1', [id]);
    if (!rows[0]) return null;
    // PHI audit (SAU-275): only the transcript is PHI — record a read when present.
    if (rows[0].transcript != null) {
      await this.recordPhiAccess({
        action: 'read', entity: 'session.transcript', entityId: id, clinicId: rows[0].clinic_id ?? null,
      });
    }
    return rowToSession(rows[0]);
  }

  async listSessionsByScenario(scenarioId: string): Promise<SessionRecord[]> {
    const { rows } = await this.q('SELECT * FROM session WHERE scenario_id = $1 ORDER BY started_at DESC', [scenarioId]);
    return rows.map(rowToSession);
  }

  async listSessionsByCourse(courseId: string): Promise<SessionRecord[]> {
    const { rows } = await this.q('SELECT * FROM session WHERE course_id = $1 ORDER BY started_at DESC', [courseId]);
    return rows.map(rowToSession);
  }

  async listSessionsByCoachUser(coachId: string, userId: string): Promise<SessionRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM session WHERE coach_id = $1 AND user_id = $2 ORDER BY started_at DESC',
      [coachId, userId],
    );
    return rows.map(rowToSession);
  }

  async listSessionEvents(sessionId: string): Promise<SessionEventRow[]> {
    const { rows } = await this.q('SELECT * FROM session_event WHERE session_id = $1 ORDER BY ts', [sessionId]);
    // PHI audit (SAU-275): event payloads are PHI — record the read when any exist.
    if (rows.length) {
      await this.recordPhiAccess({
        action: 'read', entity: 'session_event.payload', entityId: sessionId, refs: { events: rows.length },
      });
    }
    return rows.map((r: Row) => ({
      sessionId: r.session_id,
      ts: new Date(r.ts).getTime(),
      type: r.type,
      // PHI at rest (SAU-274): decrypt the event payload envelope on read.
      payload: decryptJson<Record<string, unknown>>(r.payload) ?? {},
    }));
  }

  async recordVoiceUsage(u: VoiceUsageRecord): Promise<void> {
    await this.q(
      `INSERT INTO voice_usage (session_id, user_id, scenario_id, vendor, model, tier, engine, duration_ms, voice_minutes,
        input_text_tokens, input_audio_tokens, cached_text_tokens, cached_audio_tokens,
        output_text_tokens, output_audio_tokens, total_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (session_id) DO NOTHING`,
      [u.sessionId, u.userId ?? null, u.scenarioId, u.vendor, u.model, u.tier ?? null, u.engine ?? null,
        u.durationMs, u.voiceMinutes,
        u.inputTextTokens, u.inputAudioTokens, u.cachedTextTokens, u.cachedAudioTokens,
        u.outputTextTokens, u.outputAudioTokens, u.totalTokens],
    );
  }

  async getVoiceUsage(sessionId: string): Promise<VoiceUsageRecord | null> {
    const { rows } = await this.q('SELECT * FROM voice_usage WHERE session_id = $1', [sessionId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      sessionId: r.session_id, userId: r.user_id ?? null, scenarioId: r.scenario_id, vendor: r.vendor,
      model: r.model ?? null, tier: r.tier ?? null, engine: r.engine ?? null,
      durationMs: Number(r.duration_ms), voiceMinutes: Number(r.voice_minutes),
      inputTextTokens: Number(r.input_text_tokens), inputAudioTokens: Number(r.input_audio_tokens),
      cachedTextTokens: Number(r.cached_text_tokens), cachedAudioTokens: Number(r.cached_audio_tokens),
      outputTextTokens: Number(r.output_text_tokens), outputAudioTokens: Number(r.output_audio_tokens),
      totalTokens: Number(r.total_tokens),
    };
  }

  async voiceUsageByTier(): Promise<VoiceUsageByTierRow[]> {
    const { rows } = await this.q(
      `SELECT tier, engine,
              COUNT(*)::int AS sessions,
              COALESCE(SUM(voice_minutes), 0) AS voice_minutes,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(cached_text_tokens + cached_audio_tokens), 0) AS cached_tokens
       FROM voice_usage
       GROUP BY tier, engine
       ORDER BY tier NULLS LAST, engine NULLS LAST`,
    );
    return rows.map((r) => ({
      tier: r.tier ?? null,
      engine: r.engine ?? null,
      sessions: Number(r.sessions),
      voiceMinutes: Number(Number(r.voice_minutes).toFixed(4)),
      totalTokens: Number(r.total_tokens),
      cachedTokens: Number(r.cached_tokens),
    }));
  }

  // ── Slice 2: Analyst projection ───────────────────────────────────────────────
  async upsertAnalysis(rec: NewAnalysis): Promise<AnalysisRecord> {
    const improvement = { areas: rec.improvement.areas, actionItems: rec.improvement.actionItems };
    const { rows } = await this.q(
      `INSERT INTO analysis (session_id, scenario_id, user_id, scorer, overall_score, final_score,
         report_card, strengths, weaknesses, improvement)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id, user_id = EXCLUDED.user_id, scorer = EXCLUDED.scorer,
         overall_score = EXCLUDED.overall_score, final_score = EXCLUDED.final_score,
         report_card = EXCLUDED.report_card, strengths = EXCLUDED.strengths,
         weaknesses = EXCLUDED.weaknesses, improvement = EXCLUDED.improvement, updated_at = now()
       RETURNING *`,
      [rec.sessionId, rec.scenarioId, rec.userId, rec.scorer, rec.overallScore, rec.evaluation.finalScore,
        JSON.stringify(rec.evaluation.reportCard), JSON.stringify(rec.evaluation.strengths),
        JSON.stringify(rec.evaluation.weaknesses), JSON.stringify(improvement)],
    );
    return rowToAnalysis(rows[0]);
  }

  async getAnalysis(sessionId: string): Promise<AnalysisRecord | null> {
    const { rows } = await this.q('SELECT * FROM analysis WHERE session_id = $1', [sessionId]);
    return rows[0] ? rowToAnalysis(rows[0]) : null;
  }

  // ── Clinic Intake & Booking outcome (SAU-267) — migration 0016 ───────────────
  async recordClinicOutcome(rec: ClinicOutcomeRecord): Promise<ClinicOutcomeRecord> {
    const { rows } = await this.q(
      `INSERT INTO clinic_session_outcome (session_id, scenario_id, user_id, clinic_id, outcome, event_id, event_link,
         doctor_id, doctor_name, slot_start, slot_end, calendar, simulated, intake,
         escalation_reason, handoff_action, confirmation_status, after_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)
       ON CONFLICT (session_id) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id, user_id = EXCLUDED.user_id, clinic_id = EXCLUDED.clinic_id,
         outcome = EXCLUDED.outcome, event_id = EXCLUDED.event_id, event_link = EXCLUDED.event_link,
         doctor_id = EXCLUDED.doctor_id, doctor_name = EXCLUDED.doctor_name, slot_start = EXCLUDED.slot_start,
         slot_end = EXCLUDED.slot_end, calendar = EXCLUDED.calendar, simulated = EXCLUDED.simulated,
         intake = EXCLUDED.intake, escalation_reason = EXCLUDED.escalation_reason,
         handoff_action = EXCLUDED.handoff_action, confirmation_status = EXCLUDED.confirmation_status,
         after_hours = EXCLUDED.after_hours
       RETURNING *`,
      // PHI at rest (SAU-274): `intake` carries patient identifiers (name/DOB/
      // reason/insurance) — encrypt it into an envelope before write.
      [rec.sessionId, rec.scenarioId, rec.userId, rec.clinicId ?? null, rec.outcome, rec.eventId, rec.eventLink,
        rec.doctorId, rec.doctorName, rec.slotStart, rec.slotEnd, rec.calendar, rec.simulated,
        JSON.stringify(encryptJson(rec.intake ?? {})),
        rec.escalationReason ?? null, rec.handoffAction ?? null, rec.confirmationStatus ?? null,
        rec.afterHours ?? null],
    );
    // PHI audit (SAU-275): record the write of patient intake.
    await this.recordPhiAccess({
      action: 'write', entity: 'clinic_session_outcome.intake', entityId: rec.sessionId,
      clinicId: rec.clinicId ?? null, refs: { outcome: rec.outcome },
    });
    return rowToClinicOutcome(rows[0]);
  }

  async getClinicOutcome(sessionId: string): Promise<ClinicOutcomeRecord | null> {
    const { rows } = await this.q('SELECT * FROM clinic_session_outcome WHERE session_id = $1', [sessionId]);
    if (!rows[0]) return null;
    const rec = rowToClinicOutcome(rows[0]);
    // PHI audit (SAU-275): record the read of patient intake.
    await this.recordPhiAccess({
      action: 'read', entity: 'clinic_session_outcome.intake', entityId: sessionId,
      clinicId: rec.clinicId ?? null,
    });
    return rec;
  }

  // ── Confirmation / notice delivery log (SAU-273 WS3) — migration 0020 ─────────
  async recordClinicNotification(rec: ClinicNotificationRecord): Promise<ClinicNotificationRecord> {
    const { rows } = await this.q(
      `INSERT INTO clinic_notification (session_id, user_id, clinic_id, reference, channel, audience,
         recipient_masked, status, provider_id, simulated, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [rec.sessionId, rec.userId, rec.clinicId ?? null, rec.reference, rec.channel, rec.audience,
        rec.recipientMasked, rec.status, rec.providerId ?? null, rec.simulated, rec.error ?? null],
    );
    return rowToClinicNotification(rows[0]);
  }

  async listClinicNotifications(sessionId: string): Promise<ClinicNotificationRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM clinic_notification WHERE session_id = $1 ORDER BY created_at DESC',
      [sessionId],
    );
    return rows.map(rowToClinicNotification);
  }

  // ── Multi-clinic tenancy (SAU-301, WS-B) — migration 0021 ────────────────────
  async createClinic(input: NewClinic): Promise<ClinicRecord> {
    const { rows } = await this.q(
      `INSERT INTO clinic (slug, name, created_by_user_id, config)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [input.slug, input.name, input.createdByUserId, input.config ? JSON.stringify(input.config) : null],
    );
    return rowToClinic(rows[0]);
  }

  async getClinicById(id: string): Promise<ClinicRecord | null> {
    const { rows } = await this.q('SELECT * FROM clinic WHERE id = $1', [id]);
    return rows[0] ? rowToClinic(rows[0]) : null;
  }

  async getClinicBySlug(slug: string): Promise<ClinicRecord | null> {
    const { rows } = await this.q('SELECT * FROM clinic WHERE slug = $1', [slug]);
    return rows[0] ? rowToClinic(rows[0]) : null;
  }

  async listClinicsForUser(userId: string): Promise<ClinicRecord[]> {
    // Join through membership so the list is independent of the single active
    // app.clinic_id GUC (the switcher needs every clinic the user may act for).
    const { rows } = await this.q(
      `SELECT c.* FROM clinic c
         JOIN clinic_member m ON m.clinic_id = c.id
        WHERE m.user_id = $1
        ORDER BY c.created_at ASC`,
      [userId],
    );
    return rows.map(rowToClinic);
  }

  async updateClinicConfig(clinicId: string, config: Record<string, unknown>): Promise<ClinicRecord> {
    const { rows } = await this.q(
      'UPDATE clinic SET config = $2::jsonb WHERE id = $1 RETURNING *',
      [clinicId, JSON.stringify(config)],
    );
    if (!rows[0]) throw new Error('clinic not found or not permitted');
    return rowToClinic(rows[0]);
  }

  async addClinicMember(clinicId: string, userId: string, role = 'owner'): Promise<void> {
    await this.q(
      `INSERT INTO clinic_member (clinic_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (clinic_id, user_id) DO NOTHING`,
      [clinicId, userId, role],
    );
  }

  async isClinicMember(clinicId: string, userId: string): Promise<boolean> {
    const { rows } = await this.q(
      'SELECT 1 FROM clinic_member WHERE clinic_id = $1 AND user_id = $2',
      [clinicId, userId],
    );
    return rows.length > 0;
  }

  async listClinicOutcomesForClinic(clinicId: string): Promise<ClinicOutcomeSummary[]> {
    // Non-PHI columns only — never SELECT `intake` here (no decrypt, no PHI audit).
    const { rows } = await this.q(
      `SELECT session_id, outcome, event_id, slot_start, slot_end, escalation_reason,
              handoff_action, confirmation_status, after_hours, simulated, created_at
         FROM clinic_session_outcome
        WHERE clinic_id = $1
        ORDER BY created_at DESC`,
      [clinicId],
    );
    return rows.map((r: Row) => ({
      sessionId: r.session_id,
      outcome: r.outcome,
      eventId: r.event_id ?? null,
      slotStart: r.slot_start ? new Date(r.slot_start).toISOString() : null,
      slotEnd: r.slot_end ? new Date(r.slot_end).toISOString() : null,
      escalationReason: r.escalation_reason ?? null,
      handoffAction: r.handoff_action ?? null,
      confirmationStatus: r.confirmation_status ?? null,
      afterHours: r.after_hours ?? null,
      simulated: r.simulated ?? true,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date(0).toISOString(),
    }));
  }

  async listClinicNotificationsForClinic(clinicId: string): Promise<ClinicNotificationRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM clinic_notification WHERE clinic_id = $1 ORDER BY created_at DESC',
      [clinicId],
    );
    return rows.map(rowToClinicNotification);
  }

  // ── Slice 2: History (read-model) + Creator analytics ─────────────────────────
  async listSessionHistory(userId: string): Promise<SessionHistoryRow[]> {
    const { rows } = await this.q(
      `SELECT * FROM session_history WHERE user_id = $1 ORDER BY started_at DESC`,
      [userId],
    );
    return rows.map((r: Row) => ({
      sessionId: r.session_id,
      scenarioId: r.scenario_id,
      scenarioSlug: r.scenario_slug,
      scenarioName: r.scenario_name,
      startedAt: new Date(r.started_at).toISOString(),
      endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      durationMs: r.duration_ms !== null ? Math.max(0, Math.round(Number(r.duration_ms))) : 0,
      status: r.status,
      analyzed: !!r.analyzed,
      finalScore: r.final_score !== null && r.final_score !== undefined ? Number(r.final_score) : null,
    }));
  }

  async getCreatorAnalytics(): Promise<CreatorAnalyticsRow[]> {
    const { rows } = await this.q(
      `SELECT sc.id AS scenario_id, sc.slug, sc.name,
              COUNT(s.id)::int AS sessions,
              COALESCE(AVG(EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) * 1000), 0) AS avg_duration_ms,
              COALESCE(SUM(vu.voice_minutes), 0) AS total_voice_minutes
       FROM scenario sc
       LEFT JOIN session s ON s.scenario_id = sc.id
       LEFT JOIN voice_usage vu ON vu.session_id = s.id
       GROUP BY sc.id, sc.slug, sc.name
       ORDER BY sessions DESC`,
    );
    return rows.map((r: Row) => ({
      scenarioId: r.scenario_id,
      slug: r.slug,
      name: r.name,
      sessions: Number(r.sessions),
      avgDurationMs: Math.round(Number(r.avg_duration_ms)),
      totalVoiceMinutes: Number(Number(r.total_voice_minutes).toFixed(4)),
    }));
  }

  // ── Slice 2: credit meter + entitlement ───────────────────────────────────────
  async sumVoiceMinutesByUser(userId: string): Promise<number> {
    const { rows } = await this.q(
      'SELECT COALESCE(SUM(voice_minutes), 0) AS total FROM voice_usage WHERE user_id = $1',
      [userId],
    );
    return Number(Number(rows[0].total).toFixed(4));
  }

  async sumVoiceMinutesByUserSince(userId: string, sinceMs: number): Promise<number> {
    // Scope by the SESSION start time (not voice_usage.created_at) so a session
    // is counted in the month it began — matches how History/analytics window.
    const { rows } = await this.q(
      `SELECT COALESCE(SUM(vu.voice_minutes), 0) AS total
         FROM voice_usage vu
         JOIN session s ON s.id = vu.session_id
        WHERE vu.user_id = $1 AND s.started_at >= $2`,
      [userId, new Date(sinceMs).toISOString()],
    );
    return Number(Number(rows[0].total).toFixed(4));
  }

  async getEntitlement(userId: string): Promise<EntitlementRecord | null> {
    const { rows } = await this.q('SELECT * FROM user_entitlement WHERE user_id = $1', [userId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      userId: r.user_id,
      plan: r.plan,
      freeMinutes: Number(r.free_minutes),
      paidMinutes: Number(r.paid_minutes),
      planTier: r.plan_tier ?? 'free',
    };
  }

  async upsertEntitlement(rec: EntitlementRecord): Promise<EntitlementRecord> {
    await this.q(
      `INSERT INTO user_entitlement (user_id, plan, free_minutes, paid_minutes, plan_tier)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET
         plan = EXCLUDED.plan, free_minutes = EXCLUDED.free_minutes,
         paid_minutes = EXCLUDED.paid_minutes, plan_tier = EXCLUDED.plan_tier,
         updated_at = now()`,
      [rec.userId, rec.plan, rec.freeMinutes, rec.paidMinutes, rec.planTier ?? 'free'],
    );
    return rec;
  }

  // ── Billing checkout (SAU-250) ──────────────────────────────────────────────
  async createCheckout(rec: CheckoutRecord): Promise<CheckoutRecord> {
    await this.q(
      `INSERT INTO billing_checkout (id, user_id, plan_id, billing_cycle, provider, amount_cents, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [rec.id, rec.userId, rec.planId, rec.billingCycle, rec.provider, rec.amountCents, rec.status, rec.createdAt],
    );
    return rec;
  }

  async getCheckout(id: string): Promise<CheckoutRecord | null> {
    const { rows } = await this.q('SELECT * FROM billing_checkout WHERE id = $1', [id]);
    return rows[0] ? rowToCheckout(rows[0]) : null;
  }

  async setCheckoutStatus(id: string, status: 'completed' | 'canceled'): Promise<CheckoutRecord | null> {
    const { rows } = await this.q(
      `UPDATE billing_checkout SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status],
    );
    return rows[0] ? rowToCheckout(rows[0]) : null;
  }

  async listCheckouts(userId: string): Promise<CheckoutRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM billing_checkout WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return rows.map(rowToCheckout);
  }

  // ── Developer Tools (SAU-252) — per-user API keys + webhooks ─────────────────
  async createApiKey(rec: ApiKeyRecord): Promise<ApiKeyRecord> {
    await this.q(
      `INSERT INTO api_key (id, user_id, name, key_prefix, key_hash, last_used_at, revoked_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [rec.id, rec.userId, rec.name, rec.keyPrefix, rec.keyHash, rec.lastUsedAt, rec.revokedAt, rec.createdAt],
    );
    return rec;
  }

  async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM api_key WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return rows.map(rowToApiKey);
  }

  async revokeApiKey(userId: string, id: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.q(
      `UPDATE api_key SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId],
    );
    return rows[0] ? rowToApiKey(rows[0]) : null;
  }

  async createWebhook(rec: WebhookRecord): Promise<WebhookRecord> {
    await this.q(
      `INSERT INTO webhook_endpoint (id, user_id, url, secret, events, enabled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rec.id, rec.userId, rec.url, rec.secret, rec.events, rec.enabled, rec.createdAt],
    );
    return rec;
  }

  async listWebhooks(userId: string): Promise<WebhookRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM webhook_endpoint WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return rows.map(rowToWebhook);
  }

  async deleteWebhook(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.q(
      'DELETE FROM webhook_endpoint WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── User settings (SAU-253) — per-user key/value preferences ─────────────────
  async getUserSetting(userId: string, key: string): Promise<UserSettingRecord | null> {
    const { rows } = await this.q(
      'SELECT key, value, updated_at FROM user_setting WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    return rows[0] ? rowToUserSetting(rows[0]) : null;
  }

  async listUserSettings(userId: string): Promise<UserSettingRecord[]> {
    const { rows } = await this.q(
      'SELECT key, value, updated_at FROM user_setting WHERE user_id = $1 ORDER BY key',
      [userId],
    );
    return rows.map(rowToUserSetting);
  }

  async putUserSetting(userId: string, key: string, value: Record<string, unknown>): Promise<UserSettingRecord> {
    const { rows } = await this.q(
      `INSERT INTO user_setting (user_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING key, value, updated_at`,
      [userId, key, JSON.stringify(value)],
    );
    return rowToUserSetting(rows[0]);
  }

  async deleteUserSetting(userId: string, key: string): Promise<boolean> {
    const { rowCount } = await this.q(
      'DELETE FROM user_setting WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    return (rowCount ?? 0) > 0;
  }
  // ── Coach CRUD ──────────────────────────────────────────────────────────────
  async listCoaches(): Promise<CoachRecord[]> {
    const { rows } = await this.q('SELECT * FROM coach ORDER BY created_at DESC');
    return rows.map(rowToCoach);
  }

  async getCoachBySlug(slug: string): Promise<CoachRecord | null> {
    const { rows } = await this.q('SELECT * FROM coach WHERE slug = $1', [slug]);
    return rows[0] ? rowToCoach(rows[0]) : null;
  }

  async getCoachById(id: string): Promise<CoachRecord | null> {
    const { rows } = await this.q('SELECT * FROM coach WHERE id = $1', [id]);
    return rows[0] ? rowToCoach(rows[0]) : null;
  }

  async deleteCoach(slug: string): Promise<boolean> {
    const { rowCount } = await this.q('DELETE FROM coach WHERE slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  }

  async upsertCoachFromCompile(
    rec: CompiledCoachRecord,
    source: ContentSourceInput,
    owner?: OwnerOpts,
  ): Promise<{ coach: CoachRecord; source: ContentSourceRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyActor(client);
      let scenarioId: string | null = null;
      if (rec.scenarioRef) {
        const sc = await client.query('SELECT id FROM scenario WHERE slug = $1', [rec.scenarioRef]);
        if (!sc.rows[0]) throw new Error(`coach "${rec.slug}" references unknown scenario "${rec.scenarioRef}"`);
        scenarioId = sc.rows[0].id;
      }
      const before = await client.query('SELECT id FROM coach WHERE slug = $1', [rec.slug]);
      const created = before.rowCount === 0;
      const { rows } = await client.query(
        `INSERT INTO coach (slug, name, scenario_id, inline_ai_instructions, memory_scope, retention, schedule, owner_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, scenario_id = EXCLUDED.scenario_id,
           inline_ai_instructions = EXCLUDED.inline_ai_instructions,
           memory_scope = EXCLUDED.memory_scope, retention = EXCLUDED.retention,
           schedule = EXCLUDED.schedule, updated_at = now()
         RETURNING *`,
        [rec.slug, rec.name, scenarioId, rec.inlineAiInstructions, rec.memoryScope, rec.retention,
          JSON.stringify(rec.schedule), owner?.ownerUserId ?? null],
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
    const { rows } = await this.q(`${COURSE_SELECT} ORDER BY c.created_at DESC`);
    return rows.map(rowToCourse);
  }

  async getCourseBySlug(slug: string): Promise<CourseRecord | null> {
    const { rows } = await this.q(`${COURSE_SELECT} WHERE c.slug = $1`, [slug]);
    return rows[0] ? rowToCourse(rows[0]) : null;
  }

  async getCourseById(id: string): Promise<CourseRecord | null> {
    const { rows } = await this.q(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    return rows[0] ? rowToCourse(rows[0]) : null;
  }

  async deleteCourse(slug: string): Promise<boolean> {
    const { rowCount } = await this.q('DELETE FROM course WHERE slug = $1', [slug]);
    return (rowCount ?? 0) > 0;
  }

  async upsertCourseFromCompile(
    rec: CompiledCourseRecord,
    source: ContentSourceInput,
    owner?: OwnerOpts,
  ): Promise<{ course: CourseRecord; source: ContentSourceRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyActor(client);
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
        `INSERT INTO course (slug, name, visibility, coach_id, cover_image_url, owner_user_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, visibility = EXCLUDED.visibility, coach_id = EXCLUDED.coach_id,
           cover_image_url = EXCLUDED.cover_image_url, updated_at = now()
         RETURNING id`,
        [rec.slug, rec.name, rec.isPublic ? 'public' : 'private', coachId, rec.coverImageUrl ?? null, owner?.ownerUserId ?? null],
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
    const { rows } = await this.q(
      `INSERT INTO consent_record (user_id, scope, consent_type, action, policy_version, policy_text_hash, locale, ui_surface)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [rec.userId, rec.scope, rec.consentType, rec.action, rec.policyVersion ?? null,
        rec.policyTextHash ?? null, rec.locale ?? null, rec.uiSurface ?? null],
    );
    return rowToConsent(rows[0]);
  }

  async getConsentState(userId: string, scope: string): Promise<ConsentState> {
    const { rows } = await this.q(
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
    const { rows } = await this.q(
      'SELECT * FROM consent_record WHERE user_id = $1 AND scope = $2 ORDER BY created_at DESC',
      [userId, scope],
    );
    return rows.map(rowToConsent);
  }

  async recordAuditEvent(ev: AuditEvent): Promise<void> {
    await this.q(
      `INSERT INTO audit_log (actor, event, subject_user_id, coach_id, refs) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [ev.actor, ev.event, ev.subjectUserId, ev.coachId, JSON.stringify(ev.refs)],
    );
  }

  async listAuditEvents(subjectUserId: string): Promise<(AuditEvent & { ts: string })[]> {
    const { rows } = await this.q(
      'SELECT * FROM audit_log WHERE subject_user_id = $1 ORDER BY ts DESC',
      [subjectUserId],
    );
    return rows.map((r: Row) => ({
      actor: r.actor, event: r.event, subjectUserId: r.subject_user_id ?? null,
      coachId: r.coach_id ?? null, refs: (r.refs ?? {}) as Record<string, unknown>,
      ts: new Date(r.ts).toISOString(),
    }));
  }

  // ── PHI access audit log (SAU-275) — append-only, HMAC tamper-evident ───────
  /**
   * Append one PHI read/write record. The acting principal is derived from the
   * bound actor (ALS) when not supplied — so PROGRAMMATIC AGENT access during a
   * call is captured by binding an `agent:<scenario>` actor for the call. The row
   * is HMAC-stamped over its canonical content at write; DB privileges + a trigger
   * keep the table append-only (migration 0018).
   */
  async recordPhiAccess(entry: PhiAccessInput): Promise<void> {
    const ctx = getActorContext();
    const actorUserId = ctx?.userId ? ctx.userId : null;
    const actorLabel = entry.actorLabel ?? (actorUserId ? `user:${actorUserId}` : 'system');
    const clinicId = entry.clinicId ?? ctx?.clinicId ?? null;
    const entityId = entry.entityId ?? null;
    const refs = entry.refs ?? {};
    const ts = new Date().toISOString();
    const integrity = phiAuditIntegrity({
      ts, actorUserId, actorLabel, action: entry.action, entity: entry.entity, entityId, clinicId, refs,
    });
    await this.q(
      `INSERT INTO phi_access_log (ts, actor_user_id, actor_label, action, entity, entity_id, clinic_id, refs, integrity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [ts, actorUserId, actorLabel, entry.action, entry.entity, entityId, clinicId, JSON.stringify(refs), integrity],
    );
  }

  async listPhiAccess(filter: PhiAccessFilter): Promise<PhiAccessRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.entityId) { params.push(filter.entityId); clauses.push(`entity_id = $${params.length}`); }
    if (filter.clinicId) { params.push(filter.clinicId); clauses.push(`clinic_id = $${params.length}`); }
    if (filter.actorUserId) { params.push(filter.actorUserId); clauses.push(`actor_user_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(filter.limit ?? 500, 2000));
    const { rows } = await this.q(
      `SELECT * FROM phi_access_log ${where} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToPhiAccess);
  }

  // ── Collections: debtors + compliance ledger (SAU-333, WS-2) — migration 0022 ─
  async upsertDebtor(input: NewDebtor): Promise<Debtor> {
    // PII at rest (SAU-274): name/phone/balance go into ONE encrypted envelope.
    const pii: DebtorPii = { name: input.name, phone: input.phone, balanceCents: input.balanceCents };
    const { rows } = await this.q(
      `INSERT INTO debtor (clinic_id, external_ref, pii, timezone, state, consent, opted_out, dispute_open)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
       ON CONFLICT (clinic_id, external_ref) DO UPDATE SET
         pii = EXCLUDED.pii, timezone = EXCLUDED.timezone, state = EXCLUDED.state,
         consent = EXCLUDED.consent, opted_out = EXCLUDED.opted_out, dispute_open = EXCLUDED.dispute_open
       RETURNING *`,
      [input.clinicId, input.externalRef, JSON.stringify(encryptJson(pii)), input.timezone,
        input.state ?? null, input.consent ?? false, input.optedOut ?? false, input.disputeOpen ?? false],
    );
    return rowToDebtor(rows[0]);
  }

  async getDebtor(id: string): Promise<Debtor | null> {
    const { rows } = await this.q('SELECT * FROM debtor WHERE id = $1', [id]);
    return rows[0] ? rowToDebtor(rows[0]) : null;
  }

  async getDebtorByRef(clinicId: string, externalRef: string): Promise<Debtor | null> {
    const { rows } = await this.q(
      'SELECT * FROM debtor WHERE clinic_id = $1 AND external_ref = $2',
      [clinicId, externalRef],
    );
    return rows[0] ? rowToDebtor(rows[0]) : null;
  }

  async listDebtorsForClinic(clinicId: string): Promise<Debtor[]> {
    const { rows } = await this.q(
      'SELECT * FROM debtor WHERE clinic_id = $1 ORDER BY created_at DESC',
      [clinicId],
    );
    return rows.map(rowToDebtor);
  }

  async setDebtorOptOut(id: string, optedOut: boolean): Promise<Debtor | null> {
    const { rows } = await this.q(
      `UPDATE debtor SET opted_out = $2, opted_out_at = CASE WHEN $2 THEN now() ELSE NULL END
       WHERE id = $1 RETURNING *`,
      [id, optedOut],
    );
    if (!rows[0]) return null;
    const debtor = rowToDebtor(rows[0]);
    // Guardrail 10: an opt-out is a first-class compliance event in the ledger.
    await this.recordCollectionsAudit({
      clinicId: debtor.clinicId, debtorRef: debtor.id, eventType: 'opt_out',
      reason: optedOut ? 'do_not_call' : 'opt_out_cleared', refs: { optedOut },
    });
    return debtor;
  }

  async setDebtorDispute(id: string, disputeOpen: boolean): Promise<Debtor | null> {
    const { rows } = await this.q(
      'UPDATE debtor SET dispute_open = $2 WHERE id = $1 RETURNING *',
      [id, disputeOpen],
    );
    return rows[0] ? rowToDebtor(rows[0]) : null;
  }

  /**
   * Append one compliance event to the per-tenant HMAC hash chain. The previous
   * row's integrity (the chain link) is read under a per-tenant advisory lock so
   * concurrent appends for the same lender can't fork the chain.
   */
  async recordCollectionsAudit(entry: CollectionsAuditInput): Promise<CollectionsAuditRecord> {
    const ctx = getActorContext();
    const actorUserId = ctx?.userId ? ctx.userId : null;
    const actorLabel = entry.actorLabel ?? (actorUserId ? `user:${actorUserId}` : 'system');
    const decision = entry.decision ?? null;
    const reason = entry.reason ?? null;
    const refs = entry.refs ?? {};
    const ts = new Date().toISOString();

    const run = async (c: PoolClient): Promise<CollectionsAuditRecord> => {
      // Serialize chain appends per lender (advisory lock auto-releases at tx end).
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`collections_audit:${entry.clinicId}`]);
      const prev = await c.query(
        'SELECT integrity FROM collections_audit_log WHERE clinic_id = $1 ORDER BY seq DESC LIMIT 1',
        [entry.clinicId],
      );
      const prevIntegrity = prev.rows[0]?.integrity ?? '';
      const integrity = collectionsAuditIntegrity(
        { ts, clinicId: entry.clinicId, actorUserId, actorLabel, debtorRef: entry.debtorRef,
          eventType: entry.eventType, decision, reason, refs },
        prevIntegrity,
      );
      const { rows } = await c.query(
        `INSERT INTO collections_audit_log
           (ts, clinic_id, actor_user_id, actor_label, debtor_ref, event_type, decision, reason, refs, prev_integrity, integrity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
        [ts, entry.clinicId, actorUserId, actorLabel, entry.debtorRef, entry.eventType,
          decision, reason, JSON.stringify(refs), prevIntegrity, integrity],
      );
      return rowToCollectionsAudit(rows[0]);
    };

    // Always run inside the actor transaction so the lock + read + insert are atomic.
    if (getActorContext()) return this.withActorTx(run);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await run(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async listCollectionsAudit(filter: CollectionsAuditFilter): Promise<CollectionsAuditRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.clinicId) { params.push(filter.clinicId); clauses.push(`clinic_id = $${params.length}`); }
    if (filter.debtorRef) { params.push(filter.debtorRef); clauses.push(`debtor_ref = $${params.length}`); }
    if (filter.eventType) { params.push(filter.eventType); clauses.push(`event_type = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(filter.limit ?? 500, 2000));
    const { rows } = await this.q(
      `SELECT * FROM collections_audit_log ${where} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToCollectionsAudit);
  }

  // ── Collections call-attempt outcomes (SAU-335, WS-4) — migration 0023 ───────
  async recordCallAttempt(input: NewCallAttempt): Promise<CallAttemptRecord> {
    const { outcome } = input;
    const hadConversation = outcomeHadConversation(outcome);
    const blockReason = outcome === 'blocked_by_compliance' ? (input.blockReason ?? 'blocked') : null;
    const attemptedAt = new Date(input.attemptedAtMs ?? Date.now()).toISOString();
    const { rows } = await this.q(
      `INSERT INTO collections_call_attempt
         (clinic_id, debtor_id, outcome, had_conversation, block_reason, attempted_at, simulated)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.clinicId, input.debtorId, outcome, hadConversation, blockReason, attemptedAt, input.simulated ?? true],
    );
    const rec = rowToCallAttempt(rows[0]);
    // Guardrail 10: every outcome is mirrored into the append-only compliance ledger.
    // A compliance BLOCK is a refused dial_decision; any placed call is a call_outcome.
    if (outcome === 'blocked_by_compliance') {
      await this.recordCollectionsAudit({
        clinicId: input.clinicId, debtorRef: input.debtorRef, eventType: 'dial_decision',
        decision: 'BLOCK', reason: blockReason,
        refs: { blockReasons: input.blockReasons ?? (blockReason ? [blockReason] : []) },
      });
    } else {
      await this.recordCollectionsAudit({
        clinicId: input.clinicId, debtorRef: input.debtorRef, eventType: 'call_outcome',
        reason: outcome, refs: { hadConversation },
      });
    }
    return rec;
  }

  async listCallAttemptsForDebtor(clinicId: string, debtorId: string): Promise<CallAttemptRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM collections_call_attempt WHERE clinic_id = $1 AND debtor_id = $2 ORDER BY attempted_at DESC',
      [clinicId, debtorId],
    );
    return rows.map(rowToCallAttempt);
  }

  async listCallAttemptsForClinic(clinicId: string): Promise<CallAttemptRecord[]> {
    const { rows } = await this.q(
      'SELECT * FROM collections_call_attempt WHERE clinic_id = $1 ORDER BY attempted_at DESC',
      [clinicId],
    );
    return rows.map(rowToCallAttempt);
  }

  // ── AuthN + RBAC (Slice 5, SAU-229) — no RLS on these tables; pool-direct ───
  async createUser(input: NewUser): Promise<UserRecord> {
    const email = input.email.trim().toLowerCase();
    const cols = input.id ? '(id, email, password_hash, display_name)' : '(email, password_hash, display_name)';
    const vals = input.id ? '($1,$2,$3,$4)' : '($1,$2,$3)';
    const params = input.id
      ? [input.id, email, input.passwordHash, input.displayName]
      : [email, input.passwordHash, input.displayName];
    const { rows } = await this.pool.query(`INSERT INTO app_user ${cols} VALUES ${vals} RETURNING *`, params);
    return rowToUser(rows[0]);
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM app_user WHERE email = $1', [email.trim().toLowerCase()]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM app_user WHERE id = $1', [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM app_user ORDER BY created_at');
    return rows.map(rowToUser);
  }

  async createAuthSession(token: string, userId: string, expiresAt: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO auth_session (token, user_id, expires_at) VALUES ($1,$2,$3)',
      [token, userId, expiresAt],
    );
  }

  async getAuthSession(token: string): Promise<AuthSessionRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM auth_session WHERE token = $1', [token]);
    if (!rows[0]) return null;
    return { token: rows[0].token, userId: rows[0].user_id, expiresAt: new Date(rows[0].expires_at).toISOString() };
  }

  async deleteAuthSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_session WHERE token = $1', [token]);
  }

  async setUserRole(userId: string, role: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_role WHERE user_id = $1', [userId]);
      await client.query('INSERT INTO user_role (user_id, role) VALUES ($1,$2)', [userId, role]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getUserRole(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query('SELECT role FROM user_role WHERE user_id = $1 ORDER BY role LIMIT 1', [userId]);
    return rows[0]?.role ?? null;
  }

  async getRoleCapabilities(role: string): Promise<string[]> {
    const { rows } = await this.pool.query('SELECT capability FROM role_capability WHERE role = $1', [role]);
    return rows.map((r: Row) => r.capability as string);
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
    coverImageUrl: r.cover_image_url ?? null,
    ownerUserId: r.owner_user_id ?? null,
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
