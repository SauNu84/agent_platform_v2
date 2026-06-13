/**
 * crypto.ts (SAU-261 / SAU-260) — envelope encryption for secrets at rest.
 *
 * BYO provider API keys (Settings → AI Model: OpenAI + Gemini) are stored in the
 * `user_setting` table. To make that GA-safe, the raw key never lands in the DB in
 * plaintext: it is encrypted with AES-256-GCM (authenticated) under a single
 * platform key supplied via the `SETTINGS_ENCRYPTION_KEY` env var (32-byte hex).
 *
 * Wire format (one string, base64 + colon-delimited):  iv:ciphertext:authTag
 *   - iv        12 random bytes (GCM nonce)
 *   - ciphertext the encrypted UTF-8 plaintext
 *   - authTag   16-byte GCM tag (tamper detection on decrypt)
 *
 * Production (`NODE_ENV=production`) REQUIRES the env var — a missing key throws at
 * import time so the server crashes on startup rather than silently storing secrets
 * under a guessable key. In dev/test we fall back to a fixed insecure key (with a
 * one-time console.warn) so the test suite and local runs need no extra setup.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** INSECURE, fixed dev/test fallback — never used when NODE_ENV=production. */
const DEV_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let warnedDevKey = false;

/**
 * Resolve the 32-byte encryption key. Reads `SETTINGS_ENCRYPTION_KEY` (hex) each
 * call so the value is never cached across an env change. Throws in production when
 * the env var is absent/malformed; warns once and uses the dev key otherwise.
 */
function resolveKey(): Buffer {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (hex) {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `SETTINGS_ENCRYPTION_KEY must be ${KEY_BYTES} bytes as ${KEY_BYTES * 2} hex chars (got ${buf.length} bytes).`,
      );
    }
    return buf;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY is required in production (32-byte hex) to encrypt provider keys at rest. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (!warnedDevKey) {
    warnedDevKey = true;
    console.warn(
      '[crypto] SETTINGS_ENCRYPTION_KEY not set — using an INSECURE fixed dev key. ' +
        'Set SETTINGS_ENCRYPTION_KEY before deploying to production.',
    );
  }
  return Buffer.from(DEV_KEY_HEX, 'hex');
}

// Fail fast: in production a missing/invalid key must crash startup, not at first
// use. Importing this module (which settings.ts does at server boot) runs this.
resolveKey();

/** Encrypt UTF-8 `plaintext`, returning `iv:ciphertext:authTag` (base64). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, resolveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

/** Decrypt a `iv:ciphertext:authTag` payload produced by {@link encrypt}. */
export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('crypto.decrypt: malformed ciphertext (expected iv:ct:tag).');
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv(ALGO, resolveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Heuristic: does `value` look like a payload produced by {@link encrypt}?
 * Used by the migration + read path to tell already-encrypted values apart from
 * legacy plaintext keys. The iv/tag byte-length + base64 checks make a real API
 * key (e.g. `sk-…`, `AIza…`) effectively impossible to mistake for ciphertext.
 */
export function isEncrypted(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [iv, ct, tag] = parts;
  if (!BASE64_RE.test(iv) || !BASE64_RE.test(ct) || !BASE64_RE.test(tag)) return false;
  try {
    return (
      Buffer.from(iv, 'base64').length === IV_BYTES &&
      Buffer.from(tag, 'base64').length === TAG_BYTES &&
      Buffer.from(ct, 'base64').length > 0
    );
  } catch {
    return false;
  }
}

/** Decrypt when the stored value is ciphertext; pass through legacy plaintext. */
export function decryptIfEncrypted(value: string): string {
  return isEncrypted(value) ? decrypt(value) : value;
}
