/**
 * phi.ts (SAU-274 / WS5) — PHI-at-rest envelope encryption for JSON columns.
 *
 * Phase 0 (SAU-267) stored clinic intake JSON, call transcripts, and session
 * events as PLAINTEXT jsonb — acceptable only while every patient was synthetic.
 * Before any real patient call (the Phase-1 HIPAA gate SAU-272), the PHI-bearing
 * jsonb columns must be encrypted at rest. This module is the seam that does it.
 *
 * It reuses the SAU-260/261 AES-256-GCM envelope (lib/crypto.ts) — same key
 * (`SETTINGS_ENCRYPTION_KEY`), same `iv:ct:tag` ciphertext, same prod-key fail-fast.
 * Because the source value is structured JSON (not a single string like a provider
 * key), we wrap the ciphertext in a one-key jsonb object so the column stays
 * `jsonb` and the row is self-describing:
 *
 *     plaintext  { "name": "Jane Doe", "dob": "1990-01-01", ... }
 *     at rest    { "_enc": "<base64 iv>:<base64 ct>:<base64 tag>" }
 *
 * On disk (pg_dump, WAL, base backups) only the `_enc` ciphertext is present — no
 * patient name, DOB, reason-for-visit, or transcript text. Decryption happens only
 * in-process, at the pg-store read boundary.
 *
 * Backward compatible: {@link decryptJson} passes a legacy plaintext object through
 * unchanged (no `_enc` key → not an envelope), so reads work before the 0017
 * backfill upgrades existing synthetic rows. {@link encryptJson} is the single
 * write path going forward, so all NEW rows are ciphertext.
 */
import { encrypt, decrypt } from '@/lib/crypto';

/** The single key under which the ciphertext envelope lives in a PHI jsonb column. */
const ENVELOPE_KEY = '_enc';

/** A PHI jsonb value at rest: the AES-256-GCM envelope wrapped for jsonb storage. */
export interface PhiEnvelope {
  _enc: string;
}

/** Is `value` an at-rest PHI envelope (`{ _enc: "iv:ct:tag" }`) rather than plaintext? */
export function isPhiEnvelope(value: unknown): value is PhiEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[ENVELOPE_KEY] === 'string' &&
    Object.keys(value as Record<string, unknown>).length === 1
  );
}

/**
 * Encrypt a JSON-serialisable PHI value into a jsonb-storable envelope.
 * `null`/`undefined` pass through untouched (a NULL column stays NULL). An
 * already-encrypted envelope is returned as-is so the write path is idempotent.
 */
export function encryptJson(value: unknown): PhiEnvelope | null {
  if (value === null || value === undefined) return null;
  if (isPhiEnvelope(value)) return value;
  return { [ENVELOPE_KEY]: encrypt(JSON.stringify(value)) };
}

/**
 * Decrypt a PHI jsonb value read from the DB back to its plaintext shape.
 * - An `{ _enc }` envelope → JSON.parse(decrypt(...)).
 * - Legacy plaintext (no `_enc`) → returned unchanged (pre-0017 rows).
 * - `null`/`undefined` → returned unchanged.
 * The generic `T` is the caller's expected plaintext type.
 */
export function decryptJson<T = unknown>(stored: unknown): T {
  if (stored === null || stored === undefined) return stored as T;
  if (isPhiEnvelope(stored)) return JSON.parse(decrypt(stored._enc)) as T;
  return stored as T;
}
