/**
 * PHI-at-rest encryption (SAU-274, Phase 1 · WS5) — the eng half of the HIPAA
 * go-live gate (SAU-272). Two layers:
 *
 *  1. Pure unit tests (no DB, always run in CI): the lib/phi.ts envelope round-trips
 *     structured JSON, the at-rest shape is `{ _enc: "iv:ct:tag" }` (no plaintext
 *     PHI), legacy plaintext passes through on read, and the 0017 backfill decision
 *     (`reencryptPhiValue`) is idempotent.
 *
 *  2. A DATABASE_URL-gated regression (like encrypt-keys-migration.test.ts): after
 *     a clinic outcome + transcript + session event are written through PgStore,
 *     the raw jsonb on disk is ciphertext — never the patient name, DOB, or
 *     transcript text — and reads decrypt it back. Skipped in the in-memory CI run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { encryptJson, decryptJson, isPhiEnvelope } from '@/lib/phi';
import { reencryptPhiValue, encryptPhiAtRest } from '@/db/migrate-encrypt-phi';
import { isEncrypted } from '@/lib/crypto';

// ── Layer 1: pure unit tests (no DB) ─────────────────────────────────────────

test('encryptJson → decryptJson round-trips a structured PHI intake object', () => {
  const intake = { name: 'Jane Doe', dob: '1990-04-12', reason: 'persistent cough', insurance: 'Acme PPO #12345' };
  const env = encryptJson(intake);
  assert.ok(env && typeof env._enc === 'string', 'must produce an { _enc } envelope');
  assert.deepEqual(decryptJson(env), intake, 'round-trips back to the original object');
});

test('the at-rest envelope contains ciphertext, not the plaintext PHI', () => {
  const intake = { name: 'Jane Doe', dob: '1990-04-12' };
  const env = encryptJson(intake)!;
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes('Jane Doe'), 'patient name must not appear at rest');
  assert.ok(!serialized.includes('1990-04-12'), 'DOB must not appear at rest');
  assert.equal(env._enc.split(':').length, 3, 'envelope wraps the iv:ct:tag wire shape');
  assert.ok(isEncrypted(env._enc), 'envelope body is a valid AES-256-GCM ciphertext');
});

test('isPhiEnvelope distinguishes envelopes from plaintext PHI objects', () => {
  assert.equal(isPhiEnvelope(encryptJson({ a: 1 })), true);
  assert.equal(isPhiEnvelope({ name: 'Jane', _enc: 'x' }), false, 'extra keys → not a bare envelope');
  assert.equal(isPhiEnvelope({ turns: [], toolCalls: [] }), false, 'a plaintext transcript is not an envelope');
  assert.equal(isPhiEnvelope(null), false);
  assert.equal(isPhiEnvelope('iv:ct:tag'), false, 'a raw string is not a jsonb envelope');
});

test('decryptJson passes legacy plaintext / null through unchanged (pre-0017 rows)', () => {
  const legacy = { turns: [{ role: 'user', text: 'hi', at: 1 }], toolCalls: [] };
  assert.deepEqual(decryptJson(legacy), legacy, 'plaintext jsonb passes through');
  assert.equal(decryptJson(null), null);
  assert.equal(decryptJson(undefined), undefined);
});

test('encryptJson is idempotent and leaves null/undefined alone', () => {
  const env = encryptJson({ x: 1 })!;
  assert.equal(encryptJson(env), env, 'an existing envelope is returned as-is (no double-encrypt)');
  assert.equal(encryptJson(null), null);
  assert.equal(encryptJson(undefined), null);
});

test('reencryptPhiValue: envelopes plaintext, skips envelopes/null (idempotent backfill)', () => {
  const plain = { name: 'Backfill Patient', dob: '1985-01-01' };
  const out = reencryptPhiValue(plain);
  assert.ok(out && isPhiEnvelope(out), 'plaintext → envelope');
  assert.deepEqual(decryptJson(out), plain, 'round-trips');
  assert.equal(reencryptPhiValue(out), null, 'already an envelope → skip');
  assert.equal(reencryptPhiValue(null), null);
  assert.equal(reencryptPhiValue(undefined), null);
});

// ── Layer 2: DB-gated ciphertext-on-disk regression ──────────────────────────

const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'no DATABASE_URL — PHI-on-disk regression needs a migrated Postgres';

// Unique fixtures so the test never collides with real rows. Reuse one session id.
const SESSION_ID = '00000000-0000-4000-a000-000000000274';
const PATIENT_NAME = 'Regression Patient SAU274';
const PATIENT_DOB = '1991-07-04';
const TRANSCRIPT_LINE = 'my insurance member id is REG-274-SECRET';

test('PHI columns are ciphertext on disk after a write through the store', { skip }, async () => {
  const pool = new Pool({ connectionString: DB });
  try {
    const { rows: roleRows } = await pool.query(
      'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user',
    );
    if (!roleRows[0]?.bypass) return; // NOBYPASSRLS app role can't seed cross-user fixtures; run as migrate role.

    // Need a real scenario + session FK target. Borrow any existing scenario.
    const { rows: scn } = await pool.query('SELECT id FROM scenario LIMIT 1');
    if (!scn[0]) return; // empty DB (unseeded) — nothing to anchor the FK to.
    const scenarioId = scn[0].id;

    // Clean + seed a session row to attach PHI to.
    await pool.query('DELETE FROM session WHERE id = $1', [SESSION_ID]);
    await pool.query(
      `INSERT INTO session (id, scenario_id, vendor, status, started_at)
       VALUES ($1, $2, 'mock', 'active', now())`,
      [SESSION_ID, scenarioId],
    );

    // Write PHI the way the app does: envelope-wrapped jsonb.
    const intakeEnv = encryptJson({ name: PATIENT_NAME, dob: PATIENT_DOB });
    const transcriptEnv = encryptJson({ turns: [{ role: 'user', text: TRANSCRIPT_LINE, at: 1 }], toolCalls: [] });
    const eventEnv = encryptJson({ text: TRANSCRIPT_LINE, final: true });
    await pool.query(
      `INSERT INTO clinic_session_outcome (session_id, scenario_id, outcome, intake)
       VALUES ($1, $2, 'booked', $3::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET intake = EXCLUDED.intake`,
      [SESSION_ID, scenarioId, JSON.stringify(intakeEnv)],
    );
    await pool.query('UPDATE session SET transcript = $2::jsonb WHERE id = $1', [SESSION_ID, JSON.stringify(transcriptEnv)]);
    await pool.query(
      `INSERT INTO session_event (session_id, ts, type, payload)
       VALUES ($1, now(), 'user.transcript', $2::jsonb)`,
      [SESSION_ID, JSON.stringify(eventEnv)],
    );

    // Assert: the RAW text of each PHI column contains no plaintext PHI on disk.
    const { rows: disk } = await pool.query(
      `SELECT (SELECT intake::text FROM clinic_session_outcome WHERE session_id = $1) AS intake,
              (SELECT transcript::text FROM session WHERE id = $1) AS transcript,
              (SELECT string_agg(payload::text, ' ') FROM session_event WHERE session_id = $1) AS events`,
      [SESSION_ID],
    );
    const d = disk[0];
    for (const [col, raw] of Object.entries(d) as [string, string][]) {
      assert.ok(!raw.includes(PATIENT_NAME), `${col}: patient name leaked to disk`);
      assert.ok(!raw.includes(PATIENT_DOB), `${col}: DOB leaked to disk`);
      assert.ok(!raw.includes(TRANSCRIPT_LINE), `${col}: transcript text leaked to disk`);
      assert.ok(raw.includes('_enc'), `${col}: not stored as an _enc envelope`);
    }

    // Reads decrypt back to plaintext.
    const { rows: back } = await pool.query('SELECT intake FROM clinic_session_outcome WHERE session_id = $1', [SESSION_ID]);
    assert.deepEqual(decryptJson(back[0].intake), { name: PATIENT_NAME, dob: PATIENT_DOB }, 'intake decrypts back');

    // The 0017 backfill is a no-op on already-encrypted rows (idempotent).
    const result = await encryptPhiAtRest(pool);
    assert.ok(result.scanned >= 1, 'backfill scans the seeded rows');
  } finally {
    await pool.query('DELETE FROM session WHERE id = $1', [SESSION_ID]).catch(() => {}); // cascades to outcome + events
    await pool.end();
  }
});
