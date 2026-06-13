/**
 * Data migration 0017 (SAU-274) — encrypt PHI-bearing jsonb columns already at rest.
 *
 * Phase 0 (SAU-267) wrote clinic intake JSON, call transcripts, and session-event
 * payloads as PLAINTEXT jsonb (synthetic patients only). This backfill re-wraps any
 * plaintext value with the AES-256-GCM envelope (lib/phi.ts → lib/crypto.ts) so no
 * plaintext PHI survives at rest before the Phase-1 gate (SAU-272) opens to real
 * patients.
 *
 * Like the 0014 provider-key backfill it is a DATA migration (needs the app's
 * encryption key + cipher, so it can't be plain SQL). It is tracked in
 * `schema_migrations` and is row-level idempotent: an already-encrypted `{ _enc }`
 * envelope is detected via {@link isPhiEnvelope} and skipped, so a forced re-run is
 * a no-op. Only row COUNTS are logged — never PHI values.
 */
import type { Pool } from 'pg';
import { encryptJson, isPhiEnvelope } from '@/lib/phi';

/**
 * Decide what to write for a stored PHI jsonb value: an envelope for plaintext
 * input, or `null` to skip (already an envelope, or NULL/empty). Pure +
 * unit-testable without a database.
 */
export function reencryptPhiValue(stored: unknown): { _enc: string } | null {
  if (stored === null || stored === undefined) return null;
  if (isPhiEnvelope(stored)) return null;
  return encryptJson(stored);
}

/** A PHI jsonb column to backfill: table, key column(s), and the jsonb column. */
interface PhiColumn {
  table: string;
  /** SELECT clause: primary key column(s) plus the PHI column, aliased `phi`. */
  selectSql: string;
  /** UPDATE ... SET <col> = $1 WHERE <pk predicate using $2...>. */
  updateSql: string;
  /** Map a row to the bind params AFTER the new value ($1): [$2, $3, ...]. */
  keyParams: (row: Record<string, unknown>) => unknown[];
}

const PHI_COLUMNS: PhiColumn[] = [
  {
    table: 'clinic_session_outcome.intake',
    selectSql: 'SELECT session_id, intake AS phi FROM clinic_session_outcome',
    updateSql: 'UPDATE clinic_session_outcome SET intake = $1::jsonb WHERE session_id = $2',
    keyParams: (r) => [r.session_id],
  },
  {
    table: 'session.transcript',
    selectSql: 'SELECT id, transcript AS phi FROM session WHERE transcript IS NOT NULL',
    updateSql: 'UPDATE session SET transcript = $1::jsonb WHERE id = $2',
    keyParams: (r) => [r.id],
  },
  {
    table: 'session_event.payload',
    selectSql: 'SELECT session_id, ts, payload AS phi FROM session_event',
    updateSql: 'UPDATE session_event SET payload = $1::jsonb WHERE session_id = $2 AND ts = $3',
    keyParams: (r) => [r.session_id, r.ts],
  },
];

export async function encryptPhiAtRest(pool: Pool): Promise<{ scanned: number; encrypted: number }> {
  let scanned = 0;
  let encrypted = 0;
  for (const col of PHI_COLUMNS) {
    const { rows } = await pool.query(col.selectSql);
    scanned += rows.length;
    for (const r of rows) {
      const next = reencryptPhiValue(r.phi);
      if (next === null) continue;
      await pool.query(col.updateSql, [JSON.stringify(next), ...col.keyParams(r)]);
      encrypted++;
    }
    console.log(`0017 encrypt-phi: ${col.table} — scanned ${rows.length}, encrypted ${rows.length ? encrypted : 0} cumulative.`);
  }
  console.log(`0017 encrypt-phi: scanned ${scanned} PHI row(s) across ${PHI_COLUMNS.length} columns, encrypted ${encrypted} plaintext row(s).`);
  return { scanned, encrypted };
}
