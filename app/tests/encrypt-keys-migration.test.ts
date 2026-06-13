/**
 * Data migration 0014 (SAU-261) — DB regression for encryption-at-rest of BYO
 * provider keys. This is the CISO's required check (SAU-262 verdict): after the
 * backfill runs, EVERY `model_api_key:%` row (plus the legacy
 * `voice_gemini_live_key`) must be `iv:ct:tag` ciphertext at rest — never a raw
 * `sk-…` / `AIza…` plaintext key.
 *
 * Gated on DATABASE_URL (skipped in the in-memory CI run, like rls.test.ts). The
 * backfill in migrate.ts runs as the migration owner/superuser role, so this test
 * skips under a NOBYPASSRLS app role (which couldn't see other users' rows without
 * per-request GUCs) — run it as the migrate role to exercise the backfill.
 * Self-cleaning: unique fixture rows are removed in a finally block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { encryptModelKeysAtRest } from '@/db/migrate-encrypt-model-keys';
import { isEncrypted } from '@/lib/crypto';

const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'no DATABASE_URL — migration regression needs a migrated Postgres';

// Unique fixture user ids so the test never collides with real rows.
const U_OPENAI = '00000000-0000-4000-a000-000000000261';
const U_GEMINI = '00000000-0000-4000-a000-000000000263';
const FIXTURE_USERS = [U_OPENAI, U_GEMINI];

test('0014 backfill: every model_api_key row is ciphertext at rest; no plaintext survives', { skip }, async () => {
  const pool = new Pool({ connectionString: DB });
  try {
    const { rows: roleRows } = await pool.query(
      'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user',
    );
    if (!roleRows[0]?.bypass) {
      // NOBYPASSRLS app role: the backfill (run as the migrate owner/superuser
      // role in deploy) can't see all rows here without per-request GUCs. Skip.
      return;
    }

    // Seed: one plaintext OpenAI key, one legacy plaintext Gemini key.
    await pool.query('DELETE FROM user_setting WHERE user_id = ANY($1::uuid[])', [FIXTURE_USERS]);
    const PLAINTEXT_OPENAI = 'sk-proj-regressionfixture0123456789abcdef';
    const PLAINTEXT_GEMINI = 'AIzaSy-regression-fixture-0123456789xyz';
    await pool.query(
      `INSERT INTO user_setting (user_id, key, value) VALUES
         ($1, 'model_api_key:openai', jsonb_build_object('key', $2::text)),
         ($3, 'voice_gemini_live_key', jsonb_build_object('key', $4::text))`,
      [U_OPENAI, PLAINTEXT_OPENAI, U_GEMINI, PLAINTEXT_GEMINI],
    );

    // Run the backfill exactly as migrate.ts does.
    const result = await encryptModelKeysAtRest(pool);
    assert.ok(result.encrypted >= 2, `expected to encrypt the seeded plaintext rows, got ${result.encrypted}`);

    // CISO assertion: NO provider-key row anywhere is plaintext after migrate.
    const { rows } = await pool.query(
      `SELECT key, value->>'key' AS keyval FROM user_setting
         WHERE key LIKE 'model_api_key:%' OR key = 'voice_gemini_live_key'`,
    );
    for (const r of rows) {
      assert.ok(isEncrypted(r.keyval), `row (${r.key}) is not ciphertext after migrate — possible plaintext key`);
      assert.ok(!String(r.keyval).startsWith('sk-'), 'no raw sk- key at rest');
      assert.ok(!String(r.keyval).startsWith('AIza'), 'no raw AIza key at rest');
    }

    // Idempotent: a second run encrypts nothing.
    const again = await encryptModelKeysAtRest(pool);
    assert.equal(again.encrypted, 0, 'second backfill run must be a no-op (already encrypted)');
  } finally {
    await pool.query('DELETE FROM user_setting WHERE user_id = ANY($1::uuid[])', [FIXTURE_USERS]).catch(() => {});
    await pool.end();
  }
});
