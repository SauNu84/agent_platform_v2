/**
 * Zero-dependency `.env` loader for the Slice-0 spike (SAU-181).
 *
 * Why: the `claude_local` heartbeat run env does not reliably receive the
 * board-provisioned vendor keys (company Secrets / environment-config injection
 * did not reach `process.env` of the spawned run). A gitignored `.env` in this
 * directory is the simplest provisioning path that ALSO works for the dev's
 * SAU-176 run: drop `OPENAI_API_KEY=sk-...` into `.env` and the bench reads it.
 *
 * Precedence: an already-exported env var ALWAYS wins (matches the README's
 * `export OPENAI_API_KEY=...` path); `.env` only fills vars that are unset/empty.
 * The file is in `.gitignore` — never commit real keys.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Project-config env-var aliases (SAU-176). The Paperclip project "Explore product
 * toughtongueai -v2" exposes the OpenAI credential under `env.OpenAI_Key` (a
 * `secret_ref`), but the harness/adapters read the canonical `OPENAI_API_KEY`. When
 * the project env IS injected into the runner it lands under the project's name, so
 * we normalize known aliases → canonical names. This closes the name-mismatch half of
 * the "keys absent" blocker independent of how the value is provisioned (injected env
 * or `.env`). Canonical wins if already set; aliases only fill an unset/empty target.
 */
const ENV_ALIASES: Record<string, string[]> = {
  OPENAI_API_KEY: ['OpenAI_Key', 'OPENAI_KEY'],
  // Board provisioned these under project-config names (SAU-182); normalize to canonical.
  // NOTE: 'Catesia_key' is the board's misspelling of "Cartesia" — kept as an alias so the
  // injected value resolves without requiring a rename. process.env lookup is case-sensitive,
  // so the EXACT injected names must appear here.
  GEMINI_API_KEY: ['Gemini_Key', 'GEMINI_KEY', 'GOOGLE_API_KEY', 'GoogleAPI_Key', 'Google_Key'],
  DEEPGRAM_API_KEY: ['Deepgram_key', 'Deepgram_Key', 'DEEPGRAM_KEY'],
  CARTESIA_API_KEY: ['Cartesia_Key', 'Cartesia_key', 'CARTESIA_KEY', 'Catesia_key', 'Catesia_Key'],
};

export function applyEnvAliases(): string[] {
  const applied: string[] = [];
  for (const [canonical, aliases] of Object.entries(ENV_ALIASES)) {
    if (process.env[canonical] && process.env[canonical] !== '') continue;
    for (const alias of aliases) {
      const v = process.env[alias];
      if (v && v !== '') {
        process.env[canonical] = v;
        applied.push(`${alias}→${canonical}`);
        break;
      }
    }
  }
  return applied;
}

export function loadDotEnv(dir: string): string[] {
  const loaded: string[] = [];
  const path = join(dir, '.env');
  if (existsSync(path)) {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip optional surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key] || process.env[key] === '') {
        process.env[key] = val;
        loaded.push(key);
      }
    }
  }
  // Normalize project-config aliases AFTER .env load so an injected `OpenAI_Key`
  // (no .env present) is honored too.
  loaded.push(...applyEnvAliases());
  return loaded;
}
