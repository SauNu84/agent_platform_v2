/**
 * SAU-525 — the RLS leg of call admission, against a migrated Postgres as the
 * NON-superuser app_rw role (the only role under which the policies do anything).
 *
 * Proves, through the real PgStore:
 *   1. an unbound request (no actor — what an inbound PSTN webhook is) sees NO
 *      clinic by phone number: the RLS wall the system actor exists to clear;
 *   2. admitInboundCall clears it, and every write the bridge then makes under the
 *      owner's actor (session, voice_usage) lands scoped to the tenant;
 *   3. a non-member cannot rebind a tenant's number (0021 clinic_member_update);
 *   4. one number ⇒ one tenant is enforced by the DB, not just the service.
 *
 * Gated on DATABASE_URL and self-skips under a superuser/BYPASSRLS role:
 *   DATABASE_URL=postgres://app_rw:app_rw@localhost:5544/sau525 npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { PgStore } from '@/db/pg-store';
import { runWithActor } from '@/auth/actor';
import { admitInboundCall, CallAdmissionError, BRIDGE_SYSTEM_ACTOR } from '@/services/telephony/call-admission';

const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'no DATABASE_URL — RLS test needs a migrated Postgres';

async function roleBypassesRls(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query('SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user');
  return Boolean(rows[0]?.bypass);
}

/** Raw SQL with the admin GUC set the way PgStore does (fixtures + cleanup only). */
async function asAdminSql(pool: Pool, text: string, params: unknown[]): Promise<{ rows: Array<Record<string, string>> }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true), set_config($3,$4,true)', ['app.user_id', '', 'app.is_admin', 'on']);
    const out = await client.query(text, params);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

test('call admission clears the clinic RLS wall and the call is written tenant-scoped (non-superuser)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB });
  const client = await pool.connect();
  if (await roleBypassesRls(client)) {
    client.release();
    await pool.end();
    t.skip('connection role bypasses RLS (superuser / BYPASSRLS) — run as app_rw');
    return;
  }
  client.release();
  const store = new PgStore(pool);
  const stamp = Date.now();
  const number = `+1415555${String(stamp).slice(-4)}`;
  let ownerId = '';
  let strangerId = '';
  let clinicId = '';
  let otherClinicId = '';
  let scenarioId = '';
  try {
    // Fixtures: users (app_user has no RLS), a public scenario, a clinic the owner provisions.
    const owner = await store.createUser({ email: `sau525-owner-${stamp}@demo.test`, passwordHash: 'x', displayName: 'Owner' });
    ownerId = owner.id;
    const stranger = await store.createUser({ email: `sau525-stranger-${stamp}@demo.test`, passwordHash: 'x', displayName: 'Stranger' });
    strangerId = stranger.id;
    const scn = await asAdminSql(pool, `INSERT INTO scenario (slug, name, ai_instructions, is_public) VALUES ($1,'clinic','x',true) RETURNING id`, [`sau525-scn-${stamp}`]);
    scenarioId = scn.rows[0].id;
    await runWithActor({ userId: ownerId, isAdmin: false }, async () => {
      const c = await store.createClinic({ slug: `sau525-${stamp}`, name: 'Riverside', createdByUserId: ownerId });
      clinicId = c.id;
      await store.addClinicMember(clinicId, ownerId, 'owner');
      // The owner (a member) may edit the row under clinic_member_update.
      const bound = await store.updateClinicTelephony(clinicId, { phoneNumber: number, voiceEngine: 'standard' });
      assert.equal(bound.phoneNumber, number);
    });

    // 1. An UNBOUND request — no actor, exactly what an inbound webhook is — sees
    //    nothing. This is the wall admission's scoped system actor exists to clear.
    assert.equal(await store.getClinicByPhoneNumber(number), null, 'RLS hides the clinic from an unbound request');
    assert.equal(await store.getClinicPayer(clinicId), null, 'RLS hides the owner from an unbound request');

    // 2. Admission clears the wall under its scoped system actor…
    const a = await admitInboundCall(store, { to: number });
    assert.equal(a.clinic.id, clinicId);
    assert.equal(a.ownerUserId, ownerId);
    assert.equal(a.engine.grade, 'standard');

    // …and the bridge's writes, made AS the owner, land scoped to the tenant.
    const sessionId = await runWithActor(a.actor, async () => {
      const s = await store.createSession({ scenarioId, userId: ownerId, clinicId, vendor: 'openai' });
      await store.recordVoiceUsage({
        sessionId: s.id, userId: ownerId, scenarioId, vendor: 'openai', model: a.engine.model, tier: a.tier, engine: a.engine.model,
        durationMs: 90_000, voiceMinutes: 1.5,
        inputTextTokens: 1, inputAudioTokens: 2, cachedTextTokens: 0, cachedAudioTokens: 0, outputTextTokens: 3, outputAudioTokens: 4, totalTokens: 10,
      });
      return s.id;
    });
    // The owner sees their own session + usage; a stranger sees neither.
    await runWithActor({ userId: ownerId, isAdmin: false, clinicId }, async () => {
      assert.equal((await store.getSession(sessionId))?.clinicId, clinicId);
      assert.equal((await store.getVoiceUsage(sessionId))?.voiceMinutes, 1.5);
      assert.equal(await store.sumVoiceMinutesByUserSince(ownerId, 0), 1.5, 'the meter now sees the phone minutes');
    });
    await runWithActor({ userId: strangerId, isAdmin: false }, async () => {
      assert.equal(await store.getSession(sessionId), null, 'stranger cannot read the tenant session');
      assert.equal(await store.getVoiceUsage(sessionId), null, 'stranger cannot read the tenant usage');
      assert.equal(await store.getClinicByPhoneNumber(number), null, 'stranger cannot resolve the tenant by number');
      // 3. …nor rebind its number (RLS: UPDATE matches no row ⇒ "not permitted").
      await assert.rejects(store.updateClinicTelephony(clinicId, { phoneNumber: '+14155550000' }), /not found or not permitted/);
    });
    // A second admission is refused once the owner's month is spent.
    await store.upsertEntitlement({ userId: ownerId, plan: 'free', freeMinutes: 1, paidMinutes: 0, planTier: 'free' });
    await assert.rejects(admitInboundCall(store, { to: number }), (e: unknown) => e instanceof CallAdmissionError && e.reason === 'cap_exceeded');

    // 4. One number ⇒ one tenant, enforced by clinic_phone_number_uidx.
    await runWithActor({ userId: strangerId, isAdmin: false }, async () => {
      const c = await store.createClinic({ slug: `sau525-other-${stamp}`, name: 'Other', createdByUserId: strangerId });
      otherClinicId = c.id;
      await store.addClinicMember(otherClinicId, strangerId, 'owner');
      await assert.rejects(store.updateClinicTelephony(otherClinicId, { phoneNumber: number }), /already bound/);
    });

    // 5. CTO condition (SAU-525): the creator is the payer only while still an
    //    `owner` member. Downgrade the other clinic's creator; the PgStore query
    //    must fall through to the earliest current owner, never the ex-owner.
    assert.deepEqual(await runWithActor(BRIDGE_SYSTEM_ACTOR, () => store.getClinicPayer(otherClinicId)),
      { userId: strangerId, source: 'creator' });
    await asAdminSql(pool, `UPDATE clinic_member SET role = 'staff' WHERE clinic_id = $1 AND user_id = $2`, [otherClinicId, strangerId]);
    assert.equal(await runWithActor(BRIDGE_SYSTEM_ACTOR, () => store.getClinicPayer(otherClinicId)), null,
      'a downgraded creator with no other owner is not billable');
    await asAdminSql(pool, `INSERT INTO clinic_member (clinic_id, user_id, role) VALUES ($1, $2, 'owner')`, [otherClinicId, ownerId]);
    assert.deepEqual(await runWithActor(BRIDGE_SYSTEM_ACTOR, () => store.getClinicPayer(otherClinicId)),
      { userId: ownerId, source: 'earliest_owner' });
  } finally {
    if (scenarioId) await asAdminSql(pool, 'DELETE FROM scenario WHERE id = $1', [scenarioId]).catch(() => {});
    for (const id of [clinicId, otherClinicId]) if (id) await asAdminSql(pool, 'DELETE FROM clinic WHERE id = $1', [id]).catch(() => {});
    for (const id of [ownerId, strangerId]) if (id) await pool.query('DELETE FROM app_user WHERE id = $1', [id]).catch(() => {});
    await pool.end();
  }
});
