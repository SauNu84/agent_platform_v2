/**
 * debtor-ingest.ts (SAU-333, WS-2) — synthetic debtor-list ingestion.
 *
 * SCOPE: synthetic debtors only (parent SAU-328). Parses a CSV or JSON list of FAKE
 * debtors (name, phone, debtor-local TZ, balance, consent flag, state), validates +
 * normalizes each row through the pure domain validator (domain/collections), and
 * upserts the accepted rows for ONE lender tenant. PII is encrypted at the PgStore
 * boundary; the per-row IANA time zone is REQUIRED and fail-closed (an unknown zone
 * is rejected here, because WS-1 will refuse to dial without a resolvable zone).
 *
 * Pure parsing + validation are unit-testable with no I/O; {@link ingestDebtors}
 * is the thin persistence wrapper that writes via the Store.
 */
import type { Store } from '@/db/store';
import { validateDebtorRows, type DebtorIngestValidation, type DebtorRowResult } from '@/domain/collections';

/**
 * Minimal RFC-4180-ish CSV parser (dependency-free): handles quoted fields,
 * embedded commas/quotes ("" escape), and CRLF/LF line endings. The first row is
 * the header; values map to header keys. Good enough for synthetic operator uploads.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
    else if (ch === '\r') { /* swallow; \n handles the break */ }
    else field += ch;
  }
  // flush the trailing field/row if the file didn't end with a newline.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    return obj;
  });
}

/** Parse a raw debtor list (CSV text or a JSON array/object) into untyped rows. */
export function parseDebtorList(raw: string, format: 'csv' | 'json' | 'auto' = 'auto'): Array<Record<string, unknown>> {
  const trimmed = raw.trim();
  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  const useJson = format === 'json' || (format === 'auto' && looksJson);
  if (useJson) {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.debtors) ? parsed.debtors : [parsed];
    return arr as Array<Record<string, unknown>>;
  }
  return parseCsv(raw);
}

/** Validate a raw list for a lender without writing (preview / dry-run). */
export function validateDebtorList(raw: string, clinicId: string, format: 'csv' | 'json' | 'auto' = 'auto'): DebtorIngestValidation {
  return validateDebtorRows(parseDebtorList(raw, format), clinicId);
}

export interface IngestResult {
  clinicId: string;
  total: number;
  ingested: number;
  rejected: DebtorRowResult[];
  /** ids of the debtors written (idempotent upsert on (clinic, externalRef)). */
  debtorIds: string[];
}

/**
 * Validate + persist a synthetic debtor list for ONE lender tenant. Rejected rows
 * (missing/invalid fields, unknown TZ) are reported but never written — fail-closed.
 * Re-ingesting the same list is idempotent (upsert on the lender's external_ref).
 * The caller must already be RLS-bound to `clinicId` (the upload is lender-scoped).
 */
export async function ingestDebtors(
  store: Store,
  clinicId: string,
  raw: string,
  format: 'csv' | 'json' | 'auto' = 'auto',
): Promise<IngestResult> {
  const { total, valid, rejected } = validateDebtorList(raw, clinicId, format);
  const debtorIds: string[] = [];
  for (const d of valid) {
    const rec = await store.upsertDebtor(d);
    debtorIds.push(rec.id);
  }
  return { clinicId, total, ingested: debtorIds.length, rejected, debtorIds };
}
