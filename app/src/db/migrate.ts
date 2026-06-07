/**
 * Minimal forward-only migration runner. Applies every *.sql in db/migrations in
 * filename order, tracking applied files in a `schema_migrations` table. Idempotent:
 * already-applied files are skipped; each migration's SQL uses IF NOT EXISTS so a
 * partial/expand-contract re-run is safe.
 *
 * Usage: DATABASE_URL=postgres://... npm run migrate
 */
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations.');
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename as string));
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`= skip ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      console.log(`+ applying ${file} ...`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    console.log('migrations complete.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
