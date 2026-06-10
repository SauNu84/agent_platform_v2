/**
 * Password hashing — scrypt via node:crypto (no external dependency).
 *
 * Stored format is self-describing so the work factor can evolve without a data
 * migration:  `scrypt$N$r$p$<saltB64>$<hashB64>`.
 * Verification is constant-time (timingSafeEqual) and re-derives with the
 * parameters embedded in the stored string, so old hashes keep verifying after
 * a parameter bump.
 */
import { randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Promise wrapper that preserves the options overload (promisify drops it). */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => (err ? reject(err) : resolve(derived as Buffer)));
  });
}

// OWASP-aligned defaults for interactive logins (2^15 cost).
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Synchronous hash — for the zero-infra in-memory dev seed only (the store
 * bootstrap is synchronous). Produces the same self-describing format, so the
 * async verifyPassword path validates it identically.
 */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${(derived as Buffer).toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
    maxmem: 256 * 1024 * 1024,
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
