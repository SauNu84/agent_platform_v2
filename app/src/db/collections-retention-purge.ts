/**
 * collections-retention-purge.ts (SAU-333, WS-2) — automatic synthetic-debtor disposal.
 *
 * The collections analogue of the clinic PHI purge (SAU-285): a scheduled sweep that
 * deletes debtor records once they are past their retention window. Run from cron via
 * `npm run purge:debtors` (see collections-purge-cli.ts).
 *
 * WHAT IT TOUCHES (per lender/clinic tenant):
 *   • debtor rows older than the debtor window (default 365d, per-clinic override
 *     `clinic.retention.debtorDays`) → DELETE. The PII envelope (name/phone/balance)
 *     is encrypted at rest (SAU-274), so deleting the row crypto-shreds the only
 *     ciphertext copy (backups age out within the same window).
 *   • collections_audit_log → RETAINED, never purged here. It is append-only by
 *     privilege + trigger (migration 0022); guardrail 10 requires the compliance
 *     trail to outlive the debtor data. Each disposal appends a 'purge' row to it.
 *
 * ACCOUNTABLE: every disposed debtor gets one append-only, HMAC-hash-chained 'purge'
 * row in collections_audit_log (per tenant, under the advisory lock that serializes
 * the chain). `--dry-run` reports counts and writes nothing.
 *
 * PRIVILEGE: runs with `app.is_admin='on'` so it is correct under the runtime RLS
 * role (app_rw) as a system maintenance op. The disposal is logged as the principal
 * 'system:retention-purge'. IDEMPOTENT: re-running disposes nothing already gone.
 */
import type { Pool, PoolClient } from 'pg';
import { collectionsAuditIntegrity } from '@/domain/collections-audit';

const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_ACTOR = 'system:retention-purge';

/** Platform-default debtor retention window (days), env-overridable. */
function defaultDebtorDays(): number {
  const raw = process.env.COLLECTIONS_RETENTION_DEBTOR_DAYS;
  const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 365;
}

/** Resolve a clinic's debtor window: per-clinic `retention.debtorDays` over the default. */
export function resolveDebtorDays(retention: unknown): number {
  const dflt = defaultDebtorDays();
  if (retention && typeof retention === 'object') {
    const v = (retention as Record<string, unknown>).debtorDays;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return dflt;
}

export interface ClinicDebtorPurgeResult {
  clinicId: string;
  clinicSlug: string;
  debtorDays: number;
  debtorsPurged: number;
}

export interface DebtorPurgeResult {
  ranAt: string;
  dryRun: boolean;
  clinicsScanned: number;
  debtorsPurged: number;
  /** collections_audit_log rows present (all retained — the purge never deletes them). */
  auditLogRetained: number;
  perClinic: ClinicDebtorPurgeResult[];
}

export interface DebtorPurgeOptions {
  now?: Date;
  dryRun?: boolean;
}

/** Append one HMAC-hash-chained 'purge' row for a disposed debtor (per-tenant chain). */
async function appendPurgeAudit(
  client: PoolClient,
  ts: string,
  clinicId: string,
  debtorRef: string,
  refs: Record<string, unknown>,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`collections_audit:${clinicId}`]);
  const prev = await client.query(
    'SELECT integrity FROM collections_audit_log WHERE clinic_id = $1 ORDER BY seq DESC LIMIT 1',
    [clinicId],
  );
  const prevIntegrity = prev.rows[0]?.integrity ?? '';
  const integrity = collectionsAuditIntegrity(
    { ts, clinicId, actorUserId: null, actorLabel: PURGE_ACTOR, debtorRef,
      eventType: 'purge', decision: null, reason: 'retention', refs },
    prevIntegrity,
  );
  await client.query(
    `INSERT INTO collections_audit_log
       (ts, clinic_id, actor_user_id, actor_label, debtor_ref, event_type, decision, reason, refs, prev_integrity, integrity)
     VALUES ($1,$2,$3,$4,$5,'purge',NULL,'retention',$6::jsonb,$7,$8)`,
    [ts, clinicId, null, PURGE_ACTOR, debtorRef, JSON.stringify(refs), prevIntegrity, integrity],
  );
}

/**
 * Purge expired synthetic debtors across all lender tenants. Returns a per-clinic +
 * total tally. On dryRun the transaction is rolled back and nothing is written.
 */
export async function purgeExpiredDebtors(pool: Pool, opts: DebtorPurgeOptions = {}): Promise<DebtorPurgeResult> {
  const now = opts.now ?? new Date();
  const dryRun = Boolean(opts.dryRun);
  const ranAt = now.toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.is_admin', 'on', true)");

    const { rows: clinics } = await client.query('SELECT id, slug, retention FROM clinic ORDER BY created_at');
    const perClinic: ClinicDebtorPurgeResult[] = [];

    for (const c of clinics) {
      const debtorDays = resolveDebtorDays(c.retention);
      const cutoff = new Date(now.getTime() - debtorDays * DAY_MS);
      const res: ClinicDebtorPurgeResult = { clinicId: c.id, clinicSlug: c.slug, debtorDays, debtorsPurged: 0 };

      if (dryRun) {
        const r = await client.query(
          'SELECT id FROM debtor WHERE clinic_id = $1 AND created_at < $2',
          [c.id, cutoff],
        );
        res.debtorsPurged = r.rowCount ?? 0;
      } else {
        const r = await client.query(
          'DELETE FROM debtor WHERE clinic_id = $1 AND created_at < $2 RETURNING id, external_ref',
          [c.id, cutoff],
        );
        res.debtorsPurged = r.rowCount ?? 0;
        for (const row of r.rows) {
          await appendPurgeAudit(client, ranAt, c.id, row.id, { externalRef: row.external_ref, window: `${debtorDays}d` });
        }
      }
      perClinic.push(res);
    }

    const { rows: logCount } = await client.query('SELECT count(*)::int AS n FROM collections_audit_log');
    const auditLogRetained = logCount[0]?.n ?? 0;

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');

    return {
      ranAt,
      dryRun,
      clinicsScanned: clinics.length,
      debtorsPurged: perClinic.reduce((acc, r) => acc + r.debtorsPurged, 0),
      auditLogRetained,
      perClinic,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
