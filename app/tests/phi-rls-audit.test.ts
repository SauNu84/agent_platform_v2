/**
 * Multi-clinic PHI isolation + PHI access audit log (SAU-275, Phase 1 · WS5) —
 * the eng half of the HIPAA go-live gate (SAU-272).
 *
 * CRITICAL: these tests run as the NON-SUPERUSER `app_rw` role, because Postgres
 * superusers (and BYPASSRLS roles) skip RLS entirely — the exact masking defect
 * SAU-275 closes (RLS only "worked" under the board superuser, which bypasses it).
 * The suite connects as app_rw and ASSERTS the role does not bypass RLS; if it
 * does (misconfigured), it skips with a clear pointer rather than passing falsely.
 *
 * Coverage:
 *   1. Cross-clinic isolation — Clinic A's encrypted patient outcome is invisible
 *      to a Clinic B user (and to anonymous), visible to same-clinic + admin.
 *   2. Actor-binding AC — under app_rw (with GUCs set, as the fixed binding does)
 *      a user reads its OWN private scenario and writes a session successfully.
 *   3. PHI audit log — writes/reads through PgStore append who/what/when records;
 *      the HMAC integrity tag validates and detects tampering; the table is
 *      append-only (UPDATE/DELETE rejected) even for the runtime role.
 *
 * Gated on a reachable Postgres + app_rw. Self-cleaning (finally blocks).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { PgStore } from '@/db/pg-store';
import { runWithActor } from '@/auth/actor';
import { phiAuditIntegrity, verifyPhiAuditIntegrity } from '@/lib/phi-audit';

const DB = process.env.DATABASE_URL;
// Run as app_rw (non-superuser) so FORCE RLS engages. Derive from DATABASE_URL by
// swapping the credentials, or set APP_RW_DATABASE_URL explicitly.
const APP_RW =
  process.env.APP_RW_DATABASE_URL ?? (DB ? DB.replace(/\/\/[^@]+@/, '//app_rw:app_rw@') : undefined);
const skip = APP_RW ? false : 'no DATABASE_URL/APP_RW_DATABASE_URL — needs a migrated Postgres + app_rw role';

async function roleBypassesRls(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user',
  );
  return Boolean(rows[0]?.bypass);
}
const BYPASS_SKIP =
  'connection role bypasses RLS (superuser / BYPASSRLS) — policies are inert; SAU-275 must run as app_rw.';

/** Run `fn` in a transaction with the RLS GUCs set, exactly as PgStore does. */
async function asActor(
  client: PoolClient,
  guc: { userId?: string; isAdmin?: boolean; clinicId?: string },
  fn: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT set_config($1,$2,true), set_config($3,$4,true), set_config($5,$6,true)', [
      'app.user_id', guc.userId ?? '',
      'app.is_admin', guc.isAdmin ? 'on' : 'off',
      'app.clinic_id', guc.clinicId ?? '',
    ]);
    await fn();
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

test('multi-clinic PHI isolation: Clinic A outcome is invisible to a Clinic B user', { skip }, async (t) => {
  const pool = new Pool({ connectionString: APP_RW });
  const client = await pool.connect();
  if (await roleBypassesRls(client)) {
    client.release(); await pool.end(); t.skip(BYPASS_SKIP); return;
  }
  const stamp = Date.now();
  const ids: { clinicA?: string; clinicB?: string; userA?: string; userB?: string; scenario?: string; session?: string } = {};
  try {
    // Provisioning (admin): two clinics, a shared public clinic scenario, one staff user each.
    await asActor(client, { isAdmin: true }, async () => {
      const ca = await client.query(`INSERT INTO clinic (slug, name) VALUES ($1,'A') RETURNING id`, [`clinic-a-${stamp}`]);
      const cb = await client.query(`INSERT INTO clinic (slug, name) VALUES ($1,'B') RETURNING id`, [`clinic-b-${stamp}`]);
      ids.clinicA = ca.rows[0].id; ids.clinicB = cb.rows[0].id;
      const ua = await client.query(
        `INSERT INTO app_user (email, password_hash, display_name, clinic_id) VALUES ($1,'x','A',$2) RETURNING id`,
        [`phi-a-${stamp}@demo.test`, ids.clinicA],
      );
      const ub = await client.query(
        `INSERT INTO app_user (email, password_hash, display_name, clinic_id) VALUES ($1,'x','B',$2) RETURNING id`,
        [`phi-b-${stamp}@demo.test`, ids.clinicB],
      );
      ids.userA = ua.rows[0].id; ids.userB = ub.rows[0].id;
      const sc = await client.query(
        `INSERT INTO scenario (slug, name, ai_instructions, is_public) VALUES ($1,'clinic','x',true) RETURNING id`,
        [`phi-scn-${stamp}`],
      );
      ids.scenario = sc.rows[0].id;
    });

    // Clinic A staff runs a patient session + records the (encrypted) intake outcome, tagged clinic A.
    await asActor(client, { userId: ids.userA, clinicId: ids.clinicA }, async () => {
      const se = await client.query(
        `INSERT INTO session (user_id, clinic_id, scenario_id, vendor, status) VALUES ($1,$2,$3,'mock','completed') RETURNING id`,
        [ids.userA, ids.clinicA, ids.scenario],
      );
      ids.session = se.rows[0].id;
      await client.query(
        `INSERT INTO clinic_session_outcome (session_id, scenario_id, user_id, clinic_id, outcome, intake)
         VALUES ($1,$2,$3,$4,'booked','{"_enc":"iv:ct:tag"}'::jsonb)`,
        [ids.session, ids.scenario, ids.userA, ids.clinicA],
      );
    });

    // Clinic B staff must NOT see Clinic A's patient outcome — even knowing the session id.
    await asActor(client, { userId: ids.userB, clinicId: ids.clinicB }, async () => {
      const r = await client.query('SELECT 1 FROM clinic_session_outcome WHERE session_id = $1', [ids.session]);
      assert.equal(r.rowCount, 0, "Clinic B must not read Clinic A's patient outcome (PHI)");
      const s = await client.query('SELECT 1 FROM session WHERE id = $1', [ids.session]);
      assert.equal(s.rowCount, 0, "Clinic B must not read Clinic A's session");
    });

    // Anonymous (no GUC) reads nothing.
    const anon = await client.query('SELECT 1 FROM clinic_session_outcome WHERE session_id = $1', [ids.session]);
    assert.equal(anon.rowCount, 0, 'anonymous must not read any clinic outcome');

    // Same-clinic staff (the operator) + admin DO see it.
    await asActor(client, { userId: ids.userA, clinicId: ids.clinicA }, async () => {
      const r = await client.query('SELECT outcome FROM clinic_session_outcome WHERE session_id = $1', [ids.session]);
      assert.equal(r.rowCount, 1, 'Clinic A staff reads their own clinic outcome');
    });
    await asActor(client, { isAdmin: true }, async () => {
      const r = await client.query('SELECT 1 FROM clinic_session_outcome WHERE session_id = $1', [ids.session]);
      assert.equal(r.rowCount, 1, 'admin reads any clinic outcome (DSAR/support)');
    });
  } finally {
    await asActor(client, { isAdmin: true }, async () => {
      if (ids.session) await client.query('DELETE FROM session WHERE id = $1', [ids.session]);
      if (ids.scenario) await client.query('DELETE FROM scenario WHERE id = $1', [ids.scenario]);
      if (ids.userA || ids.userB) await client.query('DELETE FROM app_user WHERE id = ANY($1)', [[ids.userA, ids.userB]]);
      if (ids.clinicA || ids.clinicB) await client.query('DELETE FROM clinic WHERE id = ANY($1)', [[ids.clinicA, ids.clinicB]]);
    });
    client.release();
    await pool.end();
  }
});

test('actor-binding AC: as app_rw a user reads its OWN private scenario and writes a session', { skip }, async (t) => {
  const pool = new Pool({ connectionString: APP_RW });
  const client = await pool.connect();
  if (await roleBypassesRls(client)) {
    client.release(); await pool.end(); t.skip(BYPASS_SKIP); return;
  }
  const stamp = Date.now();
  const slug = `phi-own-${stamp}`;
  let userA = '';
  try {
    const ua = await client.query(
      `INSERT INTO app_user (email, password_hash, display_name) VALUES ($1,'x','A') RETURNING id`,
      [`phi-own-${stamp}@demo.test`],
    );
    userA = ua.rows[0].id;

    // Under app_rw (GUCs set, as the fixed ALS binding guarantees) the owner can
    // CREATE a private scenario, READ it back, and WRITE a session — the exact
    // own-private-read + session-write path that silently failed when the actor
    // never reached PgStore.
    await asActor(client, { userId: userA }, async () => {
      await client.query(
        `INSERT INTO scenario (slug, name, ai_instructions, is_public, owner_user_id) VALUES ($1,'P','x',false,$2)`,
        [slug, userA],
      );
      const read = await client.query('SELECT name FROM scenario WHERE slug = $1', [slug]);
      assert.equal(read.rowCount, 1, 'owner reads its own private scenario under app_rw');
      const sc = await client.query('SELECT id FROM scenario WHERE slug = $1', [slug]);
      const sess = await client.query(
        `INSERT INTO session (user_id, scenario_id, vendor, status) VALUES ($1,$2,'mock','active') RETURNING id`,
        [userA, sc.rows[0].id],
      );
      assert.equal(sess.rowCount, 1, 'owner writes a session under app_rw (RLS WITH CHECK satisfied)');
    });
  } finally {
    await asActor(client, { isAdmin: true }, async () => {
      await client.query('DELETE FROM session WHERE user_id = $1', [userA]);
      await client.query('DELETE FROM scenario WHERE slug = $1', [slug]);
    });
    if (userA) await client.query('DELETE FROM app_user WHERE id = $1', [userA]);
    client.release();
    await pool.end();
  }
});

test('PHI audit log records access through PgStore, is tamper-evident, and append-only', { skip }, async (t) => {
  const pool = new Pool({ connectionString: APP_RW });
  const probe = await pool.connect();
  if (await roleBypassesRls(probe)) {
    probe.release(); await pool.end(); t.skip(BYPASS_SKIP); return;
  }
  probe.release();
  // Fixtures + cleanup run on the owner (superuser) connection: it bypasses RLS, so
  // raw inserts of clinic/user/scenario/session need no GUC dance. The PHI
  // operations UNDER TEST run on the app_rw PgStore so RLS + the audit path are real.
  const owner = new Pool({ connectionString: DB });
  const store = new PgStore(pool);
  const stamp = Date.now();
  const ids: { clinic?: string; user?: string; scenario?: string; session?: string } = {};
  try {
    const c = await owner.query(`INSERT INTO clinic (slug, name) VALUES ($1,'C') RETURNING id`, [`phi-audit-${stamp}`]);
    ids.clinic = c.rows[0].id;
    const u = await owner.query(
      `INSERT INTO app_user (email, password_hash, display_name, clinic_id) VALUES ($1,'x','U',$2) RETURNING id`,
      [`phi-audit-${stamp}@demo.test`, ids.clinic],
    );
    ids.user = u.rows[0].id;
    const sc = await owner.query(
      `INSERT INTO scenario (slug, name, ai_instructions, is_public) VALUES ($1,'clinic','x',true) RETURNING id`,
      [`phi-audit-scn-${stamp}`],
    );
    ids.scenario = sc.rows[0].id;
    const se = await owner.query(
      `INSERT INTO session (user_id, clinic_id, scenario_id, vendor, status) VALUES ($1,$2,$3,'mock','completed') RETURNING id`,
      [ids.user, ids.clinic, ids.scenario],
    );
    ids.session = se.rows[0].id;

    // Bound as the clinic staff user: record + read the clinic outcome (the encrypted
    // patient intake) through the store — each call crosses the PHI boundary.
    await runWithActor({ userId: ids.user!, isAdmin: false, clinicId: ids.clinic! }, async () => {
      await store.recordClinicOutcome({
        sessionId: ids.session!, scenarioId: ids.scenario!, userId: ids.user!, clinicId: ids.clinic!,
        outcome: 'booked', eventId: null, eventLink: null, doctorId: null, doctorName: null,
        slotStart: null, slotEnd: null, calendar: null, simulated: true,
        intake: { name: 'Jane Doe', dob: '1990-04-12', reason: 'cough' },
      });
      const got = await store.getClinicOutcome(ids.session!);
      assert.equal(got?.intake.name, 'Jane Doe', 'intake decrypts back through the store');

      // The audit log captured BOTH the write and the read for this session.
      const log = await store.listPhiAccess({ entityId: ids.session! });
      const actions = log.filter((e) => e.entity === 'clinic_session_outcome.intake').map((e) => e.action).sort();
      assert.deepEqual(actions, ['read', 'write'], 'a write and a read of patient intake are both logged');
      const rec = log.find((e) => e.action === 'write' && e.entity === 'clinic_session_outcome.intake')!;
      assert.equal(rec.clinicId, ids.clinic, 'log row is tagged with the PHI clinic');
      assert.equal(rec.actorLabel, `user:${ids.user}`, 'log names the acting principal');

      // Tamper-evidence: the stored HMAC validates over the row content...
      const content = {
        ts: rec.ts, actorUserId: rec.actorUserId, actorLabel: rec.actorLabel, action: rec.action,
        entity: rec.entity, entityId: rec.entityId, clinicId: rec.clinicId, refs: rec.refs,
      };
      assert.ok(verifyPhiAuditIntegrity(content, rec.integrity), 'integrity tag validates over the logged content');
      // ...and a single altered field (e.g. who) invalidates it.
      const forged = phiAuditIntegrity({ ...content, actorLabel: 'user:someone-else' });
      assert.notEqual(forged, rec.integrity, 'rewriting the actor changes the HMAC → tampering is detectable');
    });

    // Append-only: the runtime role cannot UPDATE or DELETE a logged row.
    const c2 = await pool.connect();
    try {
      await assert.rejects(
        c2.query(`UPDATE phi_access_log SET actor_label = 'forged' WHERE entity_id = $1`, [ids.session]),
        /append-only|permission denied/i,
        'UPDATE on the audit log must be rejected',
      );
      await assert.rejects(
        c2.query(`DELETE FROM phi_access_log WHERE entity_id = $1`, [ids.session]),
        /append-only|permission denied/i,
        'DELETE on the audit log must be rejected',
      );
    } finally {
      c2.release();
    }
  } finally {
    // Cleanup on the owner connection (superuser bypasses RLS). The phi_access_log
    // rows are intentionally LEFT in place — the table is append-only by design
    // (the trigger blocks DELETE even for the owner), and each run's entity_id is
    // unique so leftovers never affect re-runs. Deleting the session cascades to
    // its clinic_session_outcome; phi_access_log has no FK to session.
    if (ids.session) await owner.query('DELETE FROM session WHERE id = $1', [ids.session]);
    if (ids.scenario) await owner.query('DELETE FROM scenario WHERE id = $1', [ids.scenario]);
    if (ids.user) await owner.query('DELETE FROM app_user WHERE id = $1', [ids.user]);
    if (ids.clinic) await owner.query('DELETE FROM clinic WHERE id = $1', [ids.clinic]);
    await owner.end();
    await pool.end();
  }
});
