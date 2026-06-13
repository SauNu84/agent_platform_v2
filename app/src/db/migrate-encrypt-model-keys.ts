/**
 * Data migration 0014 (SAU-261) — encrypt provider API keys already at rest.
 *
 * Earlier SAU-259 cuts stored BYO provider keys (`model_api_key:<provider>` and
 * the legacy `voice_gemini_live_key`) as plaintext inside the `user_setting`
 * value blob. This backfill re-encrypts any plaintext key with AES-256-GCM
 * (lib/crypto.ts) so no plaintext provider key survives in the DB.
 *
 * It is a DATA migration (not pure SQL) because it needs the app's encryption
 * key + cipher. The runner (migrate.ts) tracks it in `schema_migrations` like a
 * file migration; it is also idempotent at the row level — already-encrypted
 * values are detected via {@link isEncrypted} and skipped, so a forced re-run is
 * a no-op. Only counts are logged, never key values.
 */
import type { Pool } from 'pg';
import { encrypt, isEncrypted } from '@/lib/crypto';

/** Rows whose `value.key` holds a provider secret. */
const PROVIDER_KEY_SQL = `SELECT user_id, key, value FROM user_setting
  WHERE key LIKE 'model_api_key:%' OR key = 'voice_gemini_live_key'`;

/**
 * Decide what to write for a stored key value: ciphertext for plaintext input,
 * or `null` to skip (already encrypted, or nothing to encrypt). Pure + unit-
 * testable without a database.
 */
export function reencryptStoredKey(stored: unknown): string | null {
  if (typeof stored !== 'string' || stored.length === 0) return null;
  if (isEncrypted(stored)) return null;
  return encrypt(stored);
}

export async function encryptModelKeysAtRest(pool: Pool): Promise<{ scanned: number; encrypted: number }> {
  const { rows } = await pool.query(PROVIDER_KEY_SQL);
  let encrypted = 0;
  for (const r of rows) {
    const next = reencryptStoredKey(r.value?.key);
    if (next === null) continue;
    await pool.query(
      `UPDATE user_setting SET value = jsonb_set(value, '{key}', $1::jsonb), updated_at = now()
       WHERE user_id = $2 AND key = $3`,
      [JSON.stringify(next), r.user_id, r.key],
    );
    encrypted++;
  }
  console.log(
    `0014 encrypt-model-keys: scanned ${rows.length} provider-key row(s), encrypted ${encrypted} plaintext row(s).`,
  );
  return { scanned: rows.length, encrypted };
}
