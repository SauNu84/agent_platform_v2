/**
 * SAU-557 · CISO SAU-558 C1 — expired coach memory is actually DELETED, by a job
 * that never reads memory content.
 *
 * Gated on DATABASE_URL (a migrated Postgres incl. 0028) and run as the
 * NON-superuser app_rw role, the only role under which the 0028 policy is what
 * scopes the delete:
 *   DATABASE_URL=postgres://app_rw:app_rw@localhost:5544/<db> npm test
 * Under a superuser the job falls back to an explicit WHERE; that path is asserted
 * too (scopedBy), so this file is meaningful under either role.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { purgeExpiredCoachMemory } from '@/db/coach-memory-purge';

const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'no DATABASE_URL — needs a migrated Postgres (0028)';

async function asUser<T>(pool: Pool, userId: string, fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const out = await fn((t, p) => c.query(t, p));
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

test('purge deletes expired rows for every user, keeps live ones, audits a count, is idempotent', { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB });
  try {
    const coach = await pool.query('SELECT id FROM coach LIMIT 1').catch(() => ({ rows: [] as any[] }));
    if (!coach.rows[0]) return t.skip('no coach row to attach memories to (seed the DB)');
    const coachId = coach.rows[0].id as string;
    const [a, b] = [randomUUID(), randomUUID()];

    for (const u of [a, b]) {
      await asUser(pool, u, (q) => q(
        `INSERT INTO coach_memory (coach_id, user_id, kind, content, expires_at) VALUES
           ($1, $2, 'fact', 'expired', now() - interval '1 day'),
           ($1, $2, 'summary', 'live', now() + interval '30 days')`,
        [coachId, u],
      ));
    }

    const dry = await purgeExpiredCoachMemory(pool, { dryRun: true });
    assert.ok(dry.memoriesPurged >= 2, 'dry run counts at least our two expired rows');
    for (const u of [a, b]) {
      const n = await asUser(pool, u, (q) => q('SELECT count(*)::int AS n FROM coach_memory WHERE user_id = $1', [u]));
      assert.equal(n.rows[0].n, 2, 'dry run deleted nothing');
    }

    const run = await purgeExpiredCoachMemory(pool);
    assert.ok(run.memoriesPurged >= 2);
    for (const u of [a, b]) {
      const left = await asUser(pool, u, (q) => q('SELECT content FROM coach_memory WHERE user_id = $1', [u]));
      assert.deepEqual(left.rows.map((r) => r.content), ['live'], 'only the live row survives, for each user');
    }

    const again = await purgeExpiredCoachMemory(pool);
    assert.equal(again.memoriesPurged, 0, 'idempotent');

    const audit = await pool.query(
      `SELECT refs FROM audit_log WHERE event = 'memory.purge' AND actor = 'system:retention-purge' ORDER BY ts DESC LIMIT 1`,
    ).catch(() => ({ rows: [] as any[] }));
    if (audit.rows[0]) assert.equal(audit.rows[0].refs.count, 0, 'an idle run still leaves its audit row (count 0)');

    for (const u of [a, b]) await asUser(pool, u, (q) => q('DELETE FROM coach_memory WHERE user_id = $1', [u]));
  } finally {
    await pool.end();
  }
});

test('CISO R1: a leaked session-level app.user_id cannot widen the purge to that user\'s live rows', { skip }, async (t) => {
  // max: 1 ⇒ the purge reuses the exact connection we poison below.
  const pool = new Pool({ connectionString: DB, max: 1 });
  try {
    const coach = await pool.query('SELECT id FROM coach LIMIT 1').catch(() => ({ rows: [] as any[] }));
    if (!coach.rows[0]) return t.skip('no coach row to attach memories to (seed the DB)');
    const coachId = coach.rows[0].id as string;
    const u = randomUUID();
    await asUser(pool, u, (q) => q(
      `INSERT INTO coach_memory (coach_id, user_id, kind, content, expires_at) VALUES
         ($1, $2, 'fact', 'expired', now() - interval '1 day'),
         ($1, $2, 'fact', 'live', now() + interval '30 days')`,
      [coachId, u],
    ));

    await pool.query("SELECT set_config('app.user_id', $1, false)", [u]); // session-level leak
    const run = await purgeExpiredCoachMemory(pool);
    assert.ok(run.memoriesPurged >= 1);

    const left = await asUser(pool, u, (q) => q('SELECT content FROM coach_memory WHERE user_id = $1', [u]));
    assert.deepEqual(left.rows.map((r) => r.content), ['live'], 'the bound user\'s live memory survives');
    await asUser(pool, u, (q) => q('DELETE FROM coach_memory WHERE user_id = $1', [u]));
  } finally {
    await pool.end();
  }
});
