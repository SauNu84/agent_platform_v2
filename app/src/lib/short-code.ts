/**
 * Short, URL-safe share codes. base62 (no look-alike-sensitive separators) over
 * crypto-random bytes — 8 chars ≈ 47 bits of entropy, plenty for share links and
 * short enough to paste in chat. The store enforces one code per scenario, so the
 * code itself only needs to be collision-resistant, not deterministic.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function genShareCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;

/** True when `code` is shaped like a share code (cheap guard before a store lookup). */
export function isShareCode(code: string): boolean {
  return CODE_RE.test(code);
}
