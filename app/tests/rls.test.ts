/**
 * DB-layer RLS enforcement (migration 0005) — the "denied at the DB" half of the
 * SAU-229 acceptance check. Verifies, against a REAL Postgres, that the scenario
 * ownership policies isolate rows by `app.user_id` and that `app.is_admin`
 * bypasses, exactly as the app sets those GUCs per request.
 *
 * Gated on DATABASE_URL: skipped in CI (which runs on the in-memory store) and
 * run by an operator/QA against a migrated database. Self-cleaning (unique
 * fixtures removed in a finally block).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';

const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'no DATABASE_URL — RLS test needs a migrated Postgres';

/** Run `fn` in a transaction with the RLS GUCs set, the way PgStore does. */
async function asActor(
  client: PoolClient,
  guc: { userId?: string; isAdmin?: boolean },
  fn: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', [
      'app.user_id', guc.userId ?? '',
      'app.is_admin', guc.isAdmin ? 'on' : 'off',
    ]);
    await fn();
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

test('scenario RLS isolates private rows by owner and lets admin bypass', { skip }, async () => {
  const pool = new Pool({ connectionString: DB });
  const client = await pool.connect();
  const stamp = Date.now();
  const slugPriv = `rls-priv-${stamp}`;
  const slugPub = `rls-pub-${stamp}`;
  let userA = '';
  let userB = '';
  try {
    // Fixtures: two users (app_user has no RLS).
    const ra = await client.query(
      `INSERT INTO app_user (email, password_hash, display_name) VALUES ($1,'x','A') RETURNING id`,
      [`rls-a-${stamp}@demo.test`],
    );
    userA = ra.rows[0].id;
    const rb = await client.query(
      `INSERT INTO app_user (email, password_hash, display_name) VALUES ($1,'x','B') RETURNING id`,
      [`rls-b-${stamp}@demo.test`],
    );
    userB = rb.rows[0].id;

    // A creates one private + one public scenario (write policy requires owner=app.user_id).
    await asActor(client, { userId: userA }, async () => {
      await client.query(
        `INSERT INTO scenario (slug, name, ai_instructions, is_public, owner_user_id) VALUES ($1,'P','x',false,$2)`,
        [slugPriv, userA],
      );
      await client.query(
        `INSERT INTO scenario (slug, name, ai_instructions, is_public, owner_user_id) VALUES ($1,'Q','x',true,$2)`,
        [slugPub, userA],
      );
    });

    // B cannot SEE A's private scenario, but CAN see the public one.
    await asActor(client, { userId: userB }, async () => {
      const priv = await client.query('SELECT 1 FROM scenario WHERE slug = $1', [slugPriv]);
      assert.equal(priv.rowCount, 0, "B must not read A's private scenario");
      const pub = await client.query('SELECT 1 FROM scenario WHERE slug = $1', [slugPub]);
      assert.equal(pub.rowCount, 1, 'public scenario is world-readable');
    });

    // B cannot MODIFY A's private scenario (UPDATE hits 0 rows under RLS).
    await asActor(client, { userId: userB }, async () => {
      const upd = await client.query(`UPDATE scenario SET name = 'hacked' WHERE slug = $1`, [slugPriv]);
      assert.equal(upd.rowCount, 0, "B must not update A's private scenario");
    });

    // Admin (is_admin = on) bypasses and sees A's private scenario.
    await asActor(client, { isAdmin: true }, async () => {
      const priv = await client.query('SELECT 1 FROM scenario WHERE slug = $1', [slugPriv]);
      assert.equal(priv.rowCount, 1, 'admin reads any row');
    });

    // A still sees its own private row.
    await asActor(client, { userId: userA }, async () => {
      const priv = await client.query('SELECT name FROM scenario WHERE slug = $1', [slugPriv]);
      assert.equal(priv.rowCount, 1);
      assert.equal(priv.rows[0].name, 'P', 'owner row was never modified by B');
    });
  } finally {
    // Cleanup as admin (delete is RLS-gated too).
    await asActor(client, { isAdmin: true }, async () => {
      await client.query('DELETE FROM scenario WHERE slug = ANY($1)', [[slugPriv, slugPub]]);
    });
    if (userA) await client.query('DELETE FROM app_user WHERE id = ANY($1)', [[userA, userB]]);
    client.release();
    await pool.end();
  }
});

test('session projections (analysis / voice_usage / session_event) isolate by owner; admin bypasses', { skip }, async () => {
  // The exact leak SAU-230 required closing: these projections are queried
  // directly by session_id, so the `session` policy does not cascade. Verify
  // each one denies a non-owner read and lets the owner + admin through.
  const pool = new Pool({ connectionString: DB });
  const client = await pool.connect();
  const stamp = Date.now();
  const slug = `rls-proj-${stamp}`;
  let userA = '';
  let userB = '';
  let sessionId = '';
  try {
    const ra = await client.query(
      `INSERT INTO app_user (email, password_hash, display_name) VALUES ($1,'x','A') RETURNING id`,
      [`rls-proj-a-${stamp}@demo.test`],
    );
    userA = ra.rows[0].id;
    const rb = await client.query(
      `INSERT INTO app_user (email, password_hash, display_name) VALUES ($1,'x','B') RETURNING id`,
      [`rls-proj-b-${stamp}@demo.test`],
    );
    userB = rb.rows[0].id;

    // A owns a scenario, runs a session, and produces all three projections.
    await asActor(client, { userId: userA }, async () => {
      const sc = await client.query(
        `INSERT INTO scenario (slug, name, ai_instructions, is_public, owner_user_id)
         VALUES ($1,'P','x',false,$2) RETURNING id`,
        [slug, userA],
      );
      const scenarioId = sc.rows[0].id;
      const se = await client.query(
        `INSERT INTO session (user_id, scenario_id, vendor, status) VALUES ($1,$2,'mock','completed') RETURNING id`,
        [userA, scenarioId],
      );
      sessionId = se.rows[0].id;
      await client.query(
        `INSERT INTO analysis (session_id, scenario_id, user_id, scorer, overall_score, final_score)
         VALUES ($1,$2,$3,'heuristic',80,80)`,
        [sessionId, scenarioId, userA],
      );
      await client.query(
        `INSERT INTO voice_usage (session_id, user_id, scenario_id, vendor) VALUES ($1,$2,$3,'mock')`,
        [sessionId, userA, scenarioId],
      );
      await client.query(
        `INSERT INTO session_event (session_id, type, payload)
         VALUES ($1,'user.transcript','{"text":"secret"}'::jsonb)`,
        [sessionId],
      );
    });

    // B (a different authenticated user) must read NONE of A's projections —
    // even though B knows the session UUID.
    await asActor(client, { userId: userB }, async () => {
      const an = await client.query('SELECT 1 FROM analysis WHERE session_id = $1', [sessionId]);
      assert.equal(an.rowCount, 0, "B must not read A's analysis (report card) by session_id");
      const vu = await client.query('SELECT 1 FROM voice_usage WHERE session_id = $1', [sessionId]);
      assert.equal(vu.rowCount, 0, "B must not read A's voice_usage by session_id");
      const ev = await client.query('SELECT 1 FROM session_event WHERE session_id = $1', [sessionId]);
      assert.equal(ev.rowCount, 0, "B must not read A's transcript turns by session_id");
    });

    // Anonymous (no GUC set) also reads nothing.
    const anon = await client.query('SELECT 1 FROM analysis WHERE session_id = $1', [sessionId]);
    assert.equal(anon.rowCount, 0, 'anonymous must not read any analysis row');

    // The owner reads all three back.
    await asActor(client, { userId: userA }, async () => {
      const an = await client.query('SELECT final_score FROM analysis WHERE session_id = $1', [sessionId]);
      assert.equal(an.rowCount, 1, 'owner reads their own analysis');
      const ev = await client.query('SELECT 1 FROM session_event WHERE session_id = $1', [sessionId]);
      assert.equal(ev.rowCount, 1, 'owner reads their own transcript turns');
    });

    // Admin bypasses (DSAR/support).
    await asActor(client, { isAdmin: true }, async () => {
      const an = await client.query('SELECT 1 FROM analysis WHERE session_id = $1', [sessionId]);
      assert.equal(an.rowCount, 1, 'admin reads any analysis row');
      const ev = await client.query('SELECT 1 FROM session_event WHERE session_id = $1', [sessionId]);
      assert.equal(ev.rowCount, 1, 'admin reads any transcript turns');
    });
  } finally {
    // Cleanup as admin (session cascade removes events/usage/analysis FKs).
    await asActor(client, { isAdmin: true }, async () => {
      if (sessionId) await client.query('DELETE FROM session WHERE id = $1', [sessionId]);
      await client.query('DELETE FROM scenario WHERE slug = $1', [slug]);
    });
    if (userA) await client.query('DELETE FROM app_user WHERE id = ANY($1)', [[userA, userB]]);
    client.release();
    await pool.end();
  }
});
