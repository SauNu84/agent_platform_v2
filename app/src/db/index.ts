/**
 * Store factory. Production uses Postgres (DATABASE_URL); without it we fall back
 * to an in-memory store so the app boots for local dev/demo with zero infra.
 * The in-memory fallback is process-local and non-durable — never production.
 */
import { Pool } from 'pg';
import type { Store } from './store';
import { PgStore } from './pg-store';
import { MemoryStore } from './memory-store';
import { loadSeedRecords } from './seed';

let singleton: Store | null = null;

export function getStore(): Store {
  if (singleton) return singleton;
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new Pool({ connectionString: url });
    singleton = new PgStore(pool);
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required in production (refusing to use the in-memory store).');
    }
    console.warn('[db] DATABASE_URL not set — using non-durable in-memory store (dev/demo only).');
    const mem = new MemoryStore();
    // Seed from content-as-code so the Library has data with zero infra.
    try {
      mem.seedSync(loadSeedRecords());
    } catch (e) {
      console.warn('[db] dev seed skipped:', (e as Error).message);
    }
    singleton = mem;
  }
  return singleton;
}

/** For tests: inject a specific store implementation. */
export function setStoreForTests(store: Store): void {
  singleton = store;
}

export type { Store } from './store';
