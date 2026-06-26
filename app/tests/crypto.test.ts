/**
 * crypto.ts (SAU-261) — AES-256-GCM envelope encryption for provider keys at rest.
 *
 * Pure unit tests (no DB): round-trip correctness, the `iv:ct:tag` wire shape,
 * tamper detection, the `isEncrypted` heuristic against real-looking API keys, and
 * the `reencryptStoredKey` decision used by the 0014 backfill. Runs in CI without
 * SETTINGS_ENCRYPTION_KEY (the dev fallback key is used).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, isEncrypted, decryptIfEncrypted, tryDecryptIfEncrypted } from '@/lib/crypto';
import { reencryptStoredKey } from '@/db/migrate-encrypt-model-keys';

/** The shape SAU-261 / the CISO regression check asserts: three base64 segments. */
const CIPHERTEXT_RE = /^[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;

test('encrypt → decrypt round-trips the plaintext', () => {
  const secret = 'sk-proj-abcdef0123456789abcdef0123456789';
  const ct = encrypt(secret);
  assert.notEqual(ct, secret, 'ciphertext must not equal plaintext');
  assert.equal(decrypt(ct), secret);
});

test('ciphertext has the iv:ct:tag base64 wire shape and is recognised by isEncrypted', () => {
  const ct = encrypt('AIzaSyA-some-google-key-value-1234567890');
  assert.match(ct, CIPHERTEXT_RE);
  assert.equal(ct.split(':').length, 3);
  assert.equal(isEncrypted(ct), true);
});

test('a fresh IV per call makes two encryptions of the same plaintext differ', () => {
  const a = encrypt('the-same-secret-value-xxxxxxxxxx');
  const b = encrypt('the-same-secret-value-xxxxxxxxxx');
  assert.notEqual(a, b, 'random IV should make ciphertexts differ');
  assert.equal(decrypt(a), decrypt(b));
});

test('tampered ciphertext fails the GCM auth tag on decrypt', () => {
  const ct = encrypt('tamper-me-please-0123456789');
  const [iv, body, tag] = ct.split(':');
  // Flip a byte in the ciphertext body.
  const buf = Buffer.from(body, 'base64');
  buf[0] ^= 0xff;
  const tampered = `${iv}:${buf.toString('base64')}:${tag}`;
  assert.throws(() => decrypt(tampered));
});

test('isEncrypted rejects real-looking plaintext API keys', () => {
  assert.equal(isEncrypted('sk-proj-abcdef0123456789abcdef0123456789'), false);
  assert.equal(isEncrypted('AIzaSyA-google-style-key-1234567890'), false);
  assert.equal(isEncrypted(''), false);
  assert.equal(isEncrypted('a:b:c'), false, 'wrong iv/tag byte lengths');
  assert.equal(isEncrypted(undefined), false);
  assert.equal(isEncrypted(42), false);
});

test('decryptIfEncrypted passes legacy plaintext through unchanged', () => {
  const plain = 'sk-legacy-plaintext-key-0123456789';
  assert.equal(decryptIfEncrypted(plain), plain);
  assert.equal(decryptIfEncrypted(encrypt(plain)), plain);
});

test('tryDecryptIfEncrypted: passes plaintext, decrypts ciphertext, returns null on undecryptable', () => {
  const plain = 'sk-legacy-plaintext-key-0123456789';
  // Legacy plaintext passes through unchanged.
  assert.equal(tryDecryptIfEncrypted(plain), plain);
  // Valid ciphertext round-trips.
  assert.equal(tryDecryptIfEncrypted(encrypt(plain)), plain);

  // Undecryptable ciphertext (simulating a rotated key / tampered row) → null,
  // NOT a throw — this is the SAU-382 fix that keeps the settings page rendering.
  const ct = encrypt('secret-encrypted-under-another-key');
  const [iv, body, tag] = ct.split(':');
  const buf = Buffer.from(body, 'base64');
  buf[0] ^= 0xff; // flip a byte so the GCM auth tag fails
  const tampered = `${iv}:${buf.toString('base64')}:${tag}`;
  assert.equal(isEncrypted(tampered), true, 'still has ciphertext wire shape');
  assert.throws(() => decryptIfEncrypted(tampered), 'strict variant still throws');
  assert.equal(tryDecryptIfEncrypted(tampered), null, 'fail-soft variant returns null');
});

test('reencryptStoredKey: encrypts plaintext, skips ciphertext, skips empty', () => {
  const plain = 'sk-needs-encrypting-0123456789abcdef';
  const out = reencryptStoredKey(plain);
  assert.notEqual(out, null);
  assert.match(out as string, CIPHERTEXT_RE);
  assert.equal(decrypt(out as string), plain, 'round-trips back to the original');

  // Already encrypted → null (no double-encryption; idempotent backfill).
  assert.equal(reencryptStoredKey(encrypt(plain)), null);
  // Nothing to do.
  assert.equal(reencryptStoredKey(''), null);
  assert.equal(reencryptStoredKey(undefined), null);
  assert.equal(reencryptStoredKey(null), null);
});
