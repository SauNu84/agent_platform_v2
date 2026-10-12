/**
 * coach-memory-purge.ts (SAU-557 · CISO SAU-558 C1) — delete expired coach memory.
 *
 * ADR-004 §1 sets the windows (summaries 365d; facts/preferences/goals 24 months
 * after last retrieval), and they are stored per row as `expires_at`. This sweep
 * deletes every row past it. That is what makes pause-on-downgrade lawful: a
 * paused user is never retrieved (so never bumped), and this purge is the
 * deletion that the consent text promises.
 *
 * HOW: under app_rw, inside one transaction with `app.is_admin = 'on'`, an
 * UNQUALIFIED `DELETE FROM coach_memory`. The 0028 policy limits that to
 * expired rows and grants no SELECT, so the job never reads memory content; it
 * only learns the count. If the connecting role bypasses RLS (superuser /
 * BYPASSRLS), the policy wouldn't apply, so the job adds the explicit
 * `WHERE expires_at <= now()` instead. The result is the same rows either way and
 * never more.
 *
 * SCOPE GUARD (CISO R1): the unqualified DELETE is scoped only by OR-ed policies.
 * If `app.user_id` were bound in this transaction, the user-isolation policy would
 * also authorize deleting that user's LIVE rows, so both tenant GUCs are rebound
 * first (transaction-local, overriding any session-level value on a reused pool)
 * to the nil UUID, which no row carries. Not '': the 0003 policy casts
 * `current_setting('app.user_id')::uuid`, and ''::uuid throws, failing the purge.
 *
 * AUDIT: one PII-free `memory.purge` row in audit_log on EVERY applied run, even
 * when it deleted 0 rows (actor `system:retention-purge`, count only), so a
 * healthy idle job is distinguishable from a dead cron. `--dry-run` rolls the
 * transaction back and writes nothing. IDEMPOTENT: a second run deletes 0.
 */
import type { Pool } from 'pg';

const PURGE_ACTOR = 'system:retention-purge';
/** Matches no row: ids are gen_random_uuid() (v4), never the nil UUID. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface CoachMemoryPurgeResult {
  ranAt: string;
  dryRun: boolean;
  /** rows deleted (or that would be, on a dry run) */
  memoriesPurged: number;
  /** how the delete was scoped: by the 0028 RLS policy, or an explicit WHERE (bypass role) */
  scopedBy: 'rls_policy' | 'explicit_where';
}

export async function purgeExpiredCoachMemory(pool: Pool, opts: { dryRun?: boolean } = {}): Promise<CoachMemoryPurgeResult> {
  const dryRun = Boolean(opts.dryRun);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT (rolsuper OR rolbypassrls) AS bypass, now() AS ran_at FROM pg_roles WHERE rolname = current_user',
    );
    const bypass = Boolean(rows[0]?.bypass);
    const ranAt = new Date(rows[0]?.ran_at ?? Date.now()).toISOString();
    // R1: an inherited app.user_id would OR the user-isolation policy into the
    // DELETE and wipe that user's live memories, so bind tenant context to the nil
    // UUID first ('' would make the policy's ::uuid cast throw).
    await client.query('SELECT set_config($1, $3, true), set_config($2, $3, true)', ['app.user_id', 'app.clinic_id', NIL_UUID]);
    await client.query("SELECT set_config('app.is_admin', 'on', true)");

    const del = await client.query(
      bypass ? 'DELETE FROM coach_memory WHERE expires_at <= now()' : 'DELETE FROM coach_memory',
    );
    const memoriesPurged = del.rowCount ?? 0;

    if (!dryRun) {
      await client.query(
        `INSERT INTO audit_log (actor, event, subject_user_id, coach_id, refs)
         VALUES ($1, 'memory.purge', NULL, NULL, $2::jsonb)`,
        [PURGE_ACTOR, JSON.stringify({ count: memoriesPurged, policy: 'ADR-004', reason: 'expired' })],
      );
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { ranAt, dryRun, memoriesPurged, scopedBy: bypass ? 'explicit_where' : 'rls_policy' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
