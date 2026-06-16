/**
 * SAU-301 (Phase 2 · WS-B) — DB-layer multi-clinic isolation, the AC #1 proof.
 *
 * Verifies against a REAL Postgres, as a NON-SUPERUSER role, that two clinics
 * coexist with zero cross-clinic data leakage on the SAU-275 clinic_id/RLS
 * foundation (migration 0018) plus the WS-B membership policies (migration 0021):
 *
 *   • clinic_member: a user sees only their own membership rows.
 *   • clinic:        a user reads only clinics they belong to (clinic_member_read).
 *   • clinic_session_outcome (PHI): Clinic A's user, scoped to A, can never read
 *     Clinic B's booking outcomes — and vice-versa. Admin sees both.
 *
 * Gated on DATABASE_URL and self-skips under a superuser/BYPASSRLS role (where the
 * policies are inert) — run it as `app_rw`:
 *   DATABASE_URL=postgres://app_rw:app_rw@localhost:5433/agent_platform npm test
 * Self-cleaning (unique fixtures removed in a finally block).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';

const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'no DATABASE_URL — RLS test needs a migrated Postgres';

async function roleBypassesRls(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user',
  );
  return Boolean(rows[0]?.bypass);
}

const BYPASS_SKIP =
  'connection role bypasses RLS (superuser / BYPASSRLS) — DB-layer policies are inert under this role; ' +
  'run as the non-superuser app_rw role to exercise per-clinic isolation.';

/** Run `fn` with the RLS GUCs set the way PgStore does (user + admin + clinic). */
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

test('multi-clinic RLS isolates clinics, memberships and PHI outcomes (non-superuser)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB });
  const client = await pool.connect();
  if (await roleBypassesRls(client)) {
    client.release();
    await pool.end();
    t.skip(BYPASS_SKIP);
    return;
  }
  const stamp = Date.now();
  const slugA = `wsb-a-${stamp}`;
  const slugB = `wsb-b-${stamp}`;
  let userA = '';
  let userB = '';
  let clinicA = '';
  let clinicB = '';
  let scenarioId = '';
  // Record one booking outcome for a clinic: needs a session (FK) + scenario (FK).
  async function recordOutcome(userId: string, clinicId: string): Promise<void> {
    await asActor(client, { userId, clinicId }, async () => {
      const s = await client.query(
        `INSERT INTO session (scenario_id, user_id, clinic_id, vendor, status)
         VALUES ($1,$2,$3,'mock','completed') RETURNING id`,
        [scenarioId, userId, clinicId],
      );
      await client.query(
        `INSERT INTO clinic_session_outcome (session_id, scenario_id, user_id, clinic_id, outcome, simulated, intake)
         VALUES ($1,$2,$3,$4,'booked',true,'{}'::jsonb)`,
        [s.rows[0].id, scenarioId, userId, clinicId],
      );
    });
  }
  try {
    // Shared public scenario (created as admin — platform content).
    await asActor(client, { isAdmin: true }, async () => {
      const r = await client.query(
        `INSERT INTO scenario (slug, name, ai_instructions, is_public) VALUES ($1,'clinic','x',true) RETURNING id`,
        [`wsb-scn-${stamp}`],
      );
      scenarioId = r.rows[0].id;
    });
    // Fixtures: two users (app_user has no RLS) and two clinics, one per user.
    const ra = await client.query(
      `INSERT INTO app_user (email, password_hash, display_name) VALUES ($1,'x','A') RETURNING id`,
      [`wsb-a-${stamp}@demo.test`],
    );
    userA = ra.rows[0].id;
    const rb = await client.query(
      `INSERT INTO app_user (email, password_hash, display_name) VALUES ($1,'x','B') RETURNING id`,
      [`wsb-b-${stamp}@demo.test`],
    );
    userB = rb.rows[0].id;

    // A provisions clinic A (RLS self-provision: created_by_user_id = self), then
    // adds itself as a member. Same for B.
    await asActor(client, { userId: userA }, async () => {
      const r = await client.query(
        `INSERT INTO clinic (slug, name, created_by_user_id) VALUES ($1,'Clinic A',$2) RETURNING id`,
        [slugA, userA],
      );
      clinicA = r.rows[0].id;
      await client.query(`INSERT INTO clinic_member (clinic_id, user_id, role) VALUES ($1,$2,'owner')`, [clinicA, userA]);
    });
    await asActor(client, { userId: userB }, async () => {
      const r = await client.query(
        `INSERT INTO clinic (slug, name, created_by_user_id) VALUES ($1,'Clinic B',$2) RETURNING id`,
        [slugB, userB],
      );
      clinicB = r.rows[0].id;
      await client.query(`INSERT INTO clinic_member (clinic_id, user_id, role) VALUES ($1,$2,'owner')`, [clinicB, userB]);
    });

    // Each clinic records one booking outcome, tagged with its clinic_id.
    await recordOutcome(userA, clinicA);
    await recordOutcome(userB, clinicB);

    // ── A, scoped to clinic A, sees ONLY clinic A everywhere ──────────────────
    await asActor(client, { userId: userA, clinicId: clinicA }, async () => {
      const clinics = await client.query('SELECT id FROM clinic WHERE id IN ($1,$2)', [clinicA, clinicB]);
      assert.deepEqual(clinics.rows.map((r) => r.id), [clinicA], 'A reads only clinic A');

      const members = await client.query('SELECT clinic_id FROM clinic_member');
      assert.ok(members.rows.every((r) => r.clinic_id === clinicA), 'A sees only its own membership');

      const outcomes = await client.query('SELECT clinic_id FROM clinic_session_outcome WHERE clinic_id IN ($1,$2)', [clinicA, clinicB]);
      assert.deepEqual(outcomes.rows.map((r) => r.clinic_id), [clinicA], 'A reads only clinic A outcomes (no PHI leak)');
    });

    // ── B, scoped to clinic B, sees ONLY clinic B ─────────────────────────────
    await asActor(client, { userId: userB, clinicId: clinicB }, async () => {
      const outcomes = await client.query('SELECT clinic_id FROM clinic_session_outcome WHERE clinic_id IN ($1,$2)', [clinicA, clinicB]);
      assert.deepEqual(outcomes.rows.map((r) => r.clinic_id), [clinicB], 'B reads only clinic B outcomes');
      const clinics = await client.query('SELECT id FROM clinic WHERE id IN ($1,$2)', [clinicA, clinicB]);
      assert.deepEqual(clinics.rows.map((r) => r.id), [clinicB], 'B reads only clinic B');
    });

    // ── Cross-user isolation: with NO clinic scope bound (app.clinic_id unset —
    //    e.g. a platform context), A still sees only rows it owns by user_id, and
    //    never B's. app.clinic_id is a SERVER-set GUC (PgStore sets it from the
    //    membership-validated active clinic via resolveActiveClinicId), so an end
    //    user can't widen their own scope; the membership gate itself is proven at
    //    the app layer in clinic-dashboard.test.ts (setActiveClinic → 403). ──────
    await asActor(client, { userId: userA }, async () => {
      const outcomes = await client.query('SELECT clinic_id FROM clinic_session_outcome WHERE clinic_id IN ($1,$2)', [clinicA, clinicB]);
      assert.deepEqual(outcomes.rows.map((r) => r.clinic_id), [clinicA], 'A (no clinic scope) sees only its own outcomes, never B');
    });

    // ── Admin bypass sees both clinics' outcomes ──────────────────────────────
    await asActor(client, { isAdmin: true }, async () => {
      const outcomes = await client.query('SELECT clinic_id FROM clinic_session_outcome WHERE clinic_id IN ($1,$2)', [clinicA, clinicB]);
      assert.equal(outcomes.rows.length, 2, 'admin sees both clinics');
    });
  } finally {
    // Cleanup as a privileged-enough context (admin GUC) — children cascade.
    await asActor(client, { isAdmin: true }, async () => {
      // Scenario cascade removes its sessions + outcomes; then drop the clinics.
      if (scenarioId) await client.query('DELETE FROM scenario WHERE id = $1', [scenarioId]);
      if (clinicA) await client.query('DELETE FROM clinic WHERE id = $1', [clinicA]);
      if (clinicB) await client.query('DELETE FROM clinic WHERE id = $1', [clinicB]);
    }).catch(() => {});
    if (userA) await client.query('DELETE FROM app_user WHERE id = $1', [userA]).catch(() => {});
    if (userB) await client.query('DELETE FROM app_user WHERE id = $1', [userB]).catch(() => {});
    client.release();
    await pool.end();
  }
});
