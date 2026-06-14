/**
 * retention-purge.ts (SAU-285, Phase 1 · WS5) — automatic PHI disposal.
 *
 * The retention POLICY is approved (program doc §4); this is its ENFORCEMENT: a
 * scheduled sweep that crypto-shreds / deletes PHI once it is past its window.
 * It is gate item 11 of the HIPAA go-live gate (SAU-272). Run it from cron via
 * `npm run purge:phi` (see retention-purge-cli.ts).
 *
 * WHAT IT TOUCHES (per provisioned clinic, windows from services/retention-policy):
 *   • call transcripts + audio + live event payloads  → default 30d
 *       - session.transcript / transcript_uri / recording_uri  → set NULL (shred)
 *       - session_event rows (live transcript/tool-call payloads) → DELETE
 *   • patient intake + booking-outcome records         → default 1y (per-clinic)
 *       - clinic_session_outcome rows                            → DELETE
 *   • phi_access_log                                   → 6y, RETAINED — never
 *       purged here (append-only by privilege + trigger, §164.316(b)(2)).
 *
 * WHY SHRED, NOT JUST DELETE: PHI is encrypted at rest (SAU-274). The encrypted
 * column / row IS the only copy of the ciphertext — nulling it or deleting the row
 * destroys the data irrecoverably (crypto-shred). Booking proof (outcome/event id)
 * lives in the SAME row as the encrypted intake on a LONGER (1y) window than the
 * transcript (30d), so we cannot just cascade-delete the session at 30d; instead we
 * null the session's transcript columns + delete its event rows at the transcript
 * window, and delete the whole outcome row at the (later) intake window. Backups age
 * out within the same window (program doc §4 / delivery note).
 *
 * SCOPE: only sessions/outcomes belonging to a provisioned `clinic` (clinic_id set)
 * are PHI under this job. Non-clinic (coaching/training) sessions follow the
 * separate ADR-004 / SAU-156 retention track and are intentionally untouched here.
 *
 * IDEMPOTENT: re-running shreds nothing already shredded (the transcript UPDATE
 * skips rows whose columns are already NULL; the deletes match nothing once the
 * rows are gone). Safe to run on any cadence. Accountable: every disposal writes an
 * append-only 'purge' row to phi_access_log (one per disposed entity), HMAC-stamped
 * like every other PHI access. `--dry-run` reports counts and writes nothing.
 *
 * PRIVILEGE: runs in a single transaction with `app.is_admin='on'` so it is correct
 * under the runtime RLS role (app_rw) as a system maintenance op, and a no-op-extra
 * under the owner/superuser connection migrations use. No request actor is bound;
 * the disposal is logged as the principal 'system:retention-purge'.
 */
import type { Pool, PoolClient } from 'pg';
import { resolveClinicWindows, DEFAULT_RETENTION, type RetentionWindows } from '@/services/retention-policy';
import { phiAuditIntegrity } from '@/lib/phi-audit';

const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_ACTOR = 'system:retention-purge';

/** Per-clinic disposal tally. */
export interface ClinicPurgeResult {
  clinicId: string;
  clinicSlug: string;
  windows: RetentionWindows;
  /** session rows whose transcript/audio columns were crypto-shredded (nulled). */
  transcriptsShredded: number;
  /** session_event rows (live transcript/tool-call payloads) deleted. */
  sessionEventsDeleted: number;
  /** clinic_session_outcome rows (encrypted intake + booking) deleted. */
  intakeRecordsPurged: number;
}

/** Whole-run report. */
export interface PurgeResult {
  ranAt: string;
  dryRun: boolean;
  clinicsScanned: number;
  transcriptsShredded: number;
  sessionEventsDeleted: number;
  intakeRecordsPurged: number;
  /** phi_access_log rows present (all retained — the purge never deletes them). */
  phiAccessLogRetained: number;
  perClinic: ClinicPurgeResult[];
}

export interface PurgeOptions {
  /** the clock to evaluate windows against (defaults to now). Injectable for tests. */
  now?: Date;
  /** compute + report counts but write nothing (no shred/delete, no audit). */
  dryRun?: boolean;
}

interface AuditEntry {
  entity: string;
  entityId: string;
  clinicId: string;
  refs: Record<string, unknown>;
}

/**
 * Purge expired PHI across all provisioned clinics. Returns a per-clinic + total
 * tally. On dryRun the transaction is rolled back and nothing is written.
 */
export async function purgeExpiredPhi(pool: Pool, opts: PurgeOptions = {}): Promise<PurgeResult> {
  const now = opts.now ?? new Date();
  const dryRun = Boolean(opts.dryRun);
  const ranAt = now.toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // System maintenance context: admin so RLS lets us reach every clinic's rows
    // under app_rw; harmless under the owner/superuser connection.
    await client.query("SELECT set_config('app.is_admin', 'on', true)");

    const { rows: clinics } = await client.query('SELECT id, slug, retention FROM clinic ORDER BY created_at');
    const perClinic: ClinicPurgeResult[] = [];
    const audit: AuditEntry[] = [];

    for (const c of clinics) {
      const windows = resolveClinicWindows(c.retention);
      const transcriptCutoff = new Date(now.getTime() - windows.transcriptDays * DAY_MS);
      const intakeCutoff = new Date(now.getTime() - windows.intakeDays * DAY_MS);

      const res: ClinicPurgeResult = {
        clinicId: c.id,
        clinicSlug: c.slug,
        windows,
        transcriptsShredded: 0,
        sessionEventsDeleted: 0,
        intakeRecordsPurged: 0,
      };

      // ── transcripts/audio (30d) ──────────────────────────────────────────
      // session_event payloads first (live transcript fragments), then the
      // session's own transcript/audio columns. Both keyed off call end time.
      let eventSessionIds: string[] = [];
      if (dryRun) {
        const r = await client.query(
          `SELECT se.session_id FROM session_event se
             JOIN session s ON s.id = se.session_id
            WHERE s.clinic_id = $1 AND COALESCE(s.ended_at, s.started_at) < $2`,
          [c.id, transcriptCutoff],
        );
        res.sessionEventsDeleted = r.rowCount ?? 0;
        eventSessionIds = [...new Set(r.rows.map((x) => x.session_id as string))];
      } else {
        const r = await client.query(
          `DELETE FROM session_event se USING session s
            WHERE se.session_id = s.id
              AND s.clinic_id = $1 AND COALESCE(s.ended_at, s.started_at) < $2
            RETURNING se.session_id`,
          [c.id, transcriptCutoff],
        );
        res.sessionEventsDeleted = r.rowCount ?? 0;
        eventSessionIds = [...new Set(r.rows.map((x) => x.session_id as string))];
      }

      const transcriptSql = `UPDATE session
           SET transcript = NULL, transcript_uri = NULL, recording_uri = NULL
         WHERE clinic_id = $1 AND COALESCE(ended_at, started_at) < $2
           AND (transcript IS NOT NULL OR transcript_uri IS NOT NULL OR recording_uri IS NOT NULL)
         RETURNING id`;
      if (dryRun) {
        const r = await client.query(
          `SELECT id FROM session
            WHERE clinic_id = $1 AND COALESCE(ended_at, started_at) < $2
              AND (transcript IS NOT NULL OR transcript_uri IS NOT NULL OR recording_uri IS NOT NULL)`,
          [c.id, transcriptCutoff],
        );
        res.transcriptsShredded = r.rowCount ?? 0;
      } else {
        const r = await client.query(transcriptSql, [c.id, transcriptCutoff]);
        res.transcriptsShredded = r.rowCount ?? 0;
        for (const row of r.rows) {
          audit.push({ entity: 'session.transcript', entityId: row.id, clinicId: c.id, refs: { window: `${windows.transcriptDays}d` } });
        }
      }
      for (const sid of eventSessionIds) {
        if (!dryRun) {
          audit.push({ entity: 'session_event.payload', entityId: sid, clinicId: c.id, refs: { window: `${windows.transcriptDays}d` } });
        }
      }

      // ── intake + booking outcome (1y, per-clinic) ────────────────────────
      if (dryRun) {
        const r = await client.query(
          'SELECT session_id FROM clinic_session_outcome WHERE clinic_id = $1 AND created_at < $2',
          [c.id, intakeCutoff],
        );
        res.intakeRecordsPurged = r.rowCount ?? 0;
      } else {
        const r = await client.query(
          'DELETE FROM clinic_session_outcome WHERE clinic_id = $1 AND created_at < $2 RETURNING session_id',
          [c.id, intakeCutoff],
        );
        res.intakeRecordsPurged = r.rowCount ?? 0;
        for (const row of r.rows) {
          audit.push({ entity: 'clinic_session_outcome.intake', entityId: row.session_id, clinicId: c.id, refs: { window: `${windows.intakeDays}d` } });
        }
      }

      perClinic.push(res);
    }

    // ── accountability: append a 'purge' row per disposed entity ────────────
    // phi_access_log is append-only + HMAC tamper-evident (0018). One row per
    // disposed (clinic, entity, session) gives per-patient disposal provenance.
    if (!dryRun && audit.length) {
      await appendPurgeAudit(client, ranAt, audit);
    }

    const { rows: logCount } = await client.query('SELECT count(*)::int AS n FROM phi_access_log');
    const phiAccessLogRetained = logCount[0]?.n ?? 0;

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    return {
      ranAt,
      dryRun,
      clinicsScanned: clinics.length,
      transcriptsShredded: sum(perClinic, (r) => r.transcriptsShredded),
      sessionEventsDeleted: sum(perClinic, (r) => r.sessionEventsDeleted),
      intakeRecordsPurged: sum(perClinic, (r) => r.intakeRecordsPurged),
      phiAccessLogRetained,
      perClinic,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Bulk-insert one append-only, HMAC-stamped 'purge' audit row per disposed entity. */
async function appendPurgeAudit(client: PoolClient, ts: string, entries: AuditEntry[]): Promise<void> {
  // Chunk to stay well under Postgres' parameter ceiling (9 params/row).
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((e, j) => {
      const integrity = phiAuditIntegrity({
        ts, actorUserId: null, actorLabel: PURGE_ACTOR, action: 'purge',
        entity: e.entity, entityId: e.entityId, clinicId: e.clinicId, refs: e.refs,
      });
      const b = j * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8}::jsonb,$${b + 9})`);
      params.push(ts, null, PURGE_ACTOR, 'purge', e.entity, e.entityId, e.clinicId, JSON.stringify(e.refs), integrity);
    });
    await client.query(
      `INSERT INTO phi_access_log (ts, actor_user_id, actor_label, action, entity, entity_id, clinic_id, refs, integrity)
       VALUES ${values.join(',')}`,
      params,
    );
  }
}

function sum<T>(rows: T[], pick: (r: T) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

export { DEFAULT_RETENTION };
