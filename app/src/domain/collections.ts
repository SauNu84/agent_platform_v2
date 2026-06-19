/**
 * Collections domain — the DEBTOR data contract + synthetic-list ingestion (SAU-333, WS-2).
 *
 * Parent: SAU-328 (Collections Agent, synthetic POC). SCOPE: synthetic debtors only.
 * Nothing here can place a real call — this is the foundation data layer.
 *
 * This module owns the two things WS-1 (the compliance engine, SAU-332) coordinates
 * against:
 *
 *   1. {@link Debtor} — the debtor record shape. WS-1's `canDialNow(debtor, now)`
 *      consumes this exact shape. The OPERATIONAL/COMPLIANCE fields (timezone, state,
 *      consent, optedOut, disputeOpen) are plaintext so the pure decision engine can
 *      read them with no decrypt; the IDENTIFYING fields (name, phone, balanceCents)
 *      are PII and live encrypted at rest (see lib/phi + PgStore boundary).
 *
 *   2. {@link CollectionsAuditInput} — the audit-write contract for guardrail 10.
 *      Every dial decision (ALLOW/BLOCK + machine-readable reason from WS-1), every
 *      call outcome, and every opt-out is appended to a tamper-evident, append-only
 *      ledger (collections_audit_log, migration 0022). `refs` carries counts/ids
 *      only — NEVER PII content.
 *
 * Tenant model: the collections use case reuses the proven `clinic` tenant primitive
 * (table `clinic` + `clinic_member` + the `app.clinic_id` RLS GUC, migrations
 * 0018/0021). A `clinic` row REPRESENTS A LENDER here; `clinicId` below is the
 * lender's tenant id. This is the deliberate "minimal net-new" choice from the WS-2
 * brief — we do not fork a parallel lender table + a second copy of the RLS plumbing.
 *
 * Everything in this file is PURE (no I/O): record shapes, the ingestion validator,
 * and the IANA timezone check. Persistence (encryption, RLS, audit) is the store's job.
 */

// ── Debtor record (the WS-1 contract) ───────────────────────────────────────

/** PII fields, held together in one AES-256-GCM envelope at rest (lib/phi). */
export interface DebtorPii {
  /** Debtor full name. */
  name: string;
  /** Phone number, E.164 (e.g. +14155550123). */
  phone: string;
  /** Outstanding balance in integer cents (avoids float drift). */
  balanceCents: number;
}

/**
 * A synthetic debtor. The plaintext shape WS-1's decision engine receives. At rest
 * the {@link DebtorPii} fields are encrypted (column `pii`) and the operational
 * fields are plaintext so RLS + the pure cadence math work without decrypting PII.
 */
export interface Debtor extends DebtorPii {
  /** Platform debtor id (uuid). */
  id: string;
  /** Owning lender/tenant id — reuses the `clinic` tenant primitive (see file header). */
  clinicId: string;
  /** The lender's own debtor key (opaque, non-PII) — used for idempotent upsert/dedup. */
  externalRef: string;
  /** IANA time zone of the debtor (e.g. America/New_York). WS-1 FAIL-CLOSES on unknown. */
  timezone: string;
  /** US state code (e.g. CA) for per-state caps; null if unknown. NOT PII. */
  state: string | null;
  /** Consent-to-contact flag. WS-1 blocks the dial when false (consent gate). */
  consent: boolean;
  /** Do-not-call / opt-out. Once true, WS-1 suppresses all dials. */
  optedOut: boolean;
  /** When the opt-out was recorded (ISO), else null. */
  optedOutAt: string | null;
  /** An open validation dispute PAUSES calling for this debtor (WS-1 guardrail 9). */
  disputeOpen: boolean;
  /**
   * §1692g (SAU-356/F2): when the validation notice was sent to this debtor (ISO), or
   * null if not yet sent/unknown. The 30-day dispute window is DERIVED from this
   * ({@link disputeWindowEndsAt}); tracked so the §1692g obligation is evidenced per
   * debtor (SAU-330 §6 #9). NOT PII.
   */
  validationNoticeSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields for creating/upserting a debtor (PII + operational). Server stamps id/timestamps. */
export interface NewDebtor extends DebtorPii {
  clinicId: string;
  externalRef: string;
  timezone: string;
  state?: string | null;
  consent?: boolean;
  optedOut?: boolean;
  disputeOpen?: boolean;
  /** §1692g validation-notice timestamp (ISO), if known at ingest. Default null. */
  validationNoticeSentAt?: string | null;
}

// ── Compliance audit (guardrail 10) write contract ──────────────────────────

/** What kind of compliance-relevant event is being recorded. */
export type CollectionsAuditEventType =
  | 'dial_decision' // a canDialNow result (ALLOW/BLOCK + reason) — WS-1
  | 'call_outcome'  // the result of an attempted/placed call — WS-3
  | 'opt_out'       // a debtor opt-out / do-not-call request
  | 'purge';        // retention disposal of a debtor record (SAU-285 pattern)

/** The two-valued dial decision from WS-1's engine. */
export type DialDecision = 'ALLOW' | 'BLOCK';

/**
 * One compliance event to append to the tamper-evident ledger. `refs` is for
 * counts/ids only (e.g. {@code { callsLast7: 3 }}) and MUST NOT carry PII content.
 */
export interface CollectionsAuditInput {
  /** Owning lender/tenant id (the per-tenant hash chain is keyed on this). */
  clinicId: string;
  /** Debtor id or externalRef — an identifier, NOT PII (never the name/phone). */
  debtorRef: string;
  eventType: CollectionsAuditEventType;
  /** ALLOW/BLOCK for a dial_decision; null for other event types. */
  decision?: DialDecision | null;
  /** Machine-readable reason code from WS-1 (e.g. 'outside_window'), or an outcome label. */
  reason?: string | null;
  /** Override the principal label (defaults to the bound actor, else 'system'). */
  actorLabel?: string;
  /** Counts/ids only — NEVER PII content. */
  refs?: Record<string, unknown>;
}

/** A persisted, append-only compliance audit row (read back for review / cadence). */
export interface CollectionsAuditRecord {
  id: string;
  seq: number;
  ts: string;
  clinicId: string;
  actorUserId: string | null;
  actorLabel: string;
  debtorRef: string;
  eventType: CollectionsAuditEventType;
  decision: DialDecision | null;
  reason: string | null;
  refs: Record<string, unknown>;
  /** integrity tag of the PREVIOUS row in this tenant's chain ('' for the first row). */
  prevIntegrity: string;
  /** base64 HMAC-SHA256 over this row's canonical content + prevIntegrity (chain link). */
  integrity: string;
}

export interface CollectionsAuditFilter {
  clinicId?: string;
  debtorRef?: string;
  eventType?: CollectionsAuditEventType;
  limit?: number;
}

// ── Synthetic-list ingestion (CSV/JSON) ─────────────────────────────────────

/** Is `tz` a runtime-resolvable IANA time zone? (the basis for WS-1's fail-closed gate). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    // Throws RangeError for an unknown/invalid zone. No external dependency.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Loose, dependency-free E.164 check: a leading '+' then 8–15 digits. */
function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone.trim());
}

/** Parse a permissive boolean cell from a CSV/JSON value (true/false/yes/no/1/0). */
function parseBool(v: unknown, dflt = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(s)) return true;
    if (['false', 'no', 'n', '0', ''].includes(s)) return false;
  }
  return dflt;
}

/** Parse a balance cell into integer cents. Accepts "1234.56", "1234", or cents number. */
function parseBalanceCents(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100);
  if (typeof v === 'string') {
    const s = v.replace(/[$,\s]/g, '');
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }
  return null;
}

/** Parse an optional ISO timestamp cell into a normalized ISO string, or null. Invalid
 *  or empty → null (the §1692g notice is simply "not recorded" rather than a hard reject). */
function parseIsoTimestamp(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A single row's validation result. */
export interface DebtorRowResult {
  ok: boolean;
  row: number;
  debtor?: NewDebtor;
  errors?: string[];
}

/**
 * Validate + normalize one raw ingestion row into a {@link NewDebtor}. FAIL-CLOSED:
 * a missing/invalid required field (externalRef, name, phone, timezone, balance) is
 * a hard reject — most importantly an UNKNOWN TIME ZONE, since WS-1 will refuse to
 * dial without a resolvable zone (guardrail 6). The lender tenant id is supplied by
 * the caller (the upload is already scoped to one authenticated lender).
 */
export function validateDebtorRow(
  raw: Record<string, unknown>,
  clinicId: string,
  rowIndex: number,
): DebtorRowResult {
  const errors: string[] = [];
  const get = (k: string): unknown => raw[k] ?? raw[k.toLowerCase()] ?? raw[k.toUpperCase()];

  const externalRef = String(get('externalRef') ?? get('external_ref') ?? get('id') ?? '').trim();
  if (!externalRef) errors.push('externalRef is required');

  const name = String(get('name') ?? '').trim();
  if (!name) errors.push('name is required');

  const phone = String(get('phone') ?? '').trim();
  if (!phone) errors.push('phone is required');
  else if (!isE164(phone)) errors.push(`phone "${phone}" is not E.164 (e.g. +14155550123)`);

  const timezone = String(get('timezone') ?? get('tz') ?? '').trim();
  if (!timezone) errors.push('timezone is required (WS-1 fail-closes on unknown TZ)');
  else if (!isValidTimeZone(timezone)) errors.push(`timezone "${timezone}" is not a valid IANA zone`);

  const balanceCents = parseBalanceCents(get('balance') ?? get('balanceCents') ?? get('balance_cents'));
  if (balanceCents == null) errors.push('balance is required and must be numeric');
  else if (balanceCents < 0) errors.push('balance must not be negative');

  const stateRaw = get('state');
  const state = stateRaw == null || String(stateRaw).trim() === '' ? null : String(stateRaw).trim().toUpperCase();

  if (errors.length) return { ok: false, row: rowIndex, errors };

  return {
    ok: true,
    row: rowIndex,
    debtor: {
      clinicId,
      externalRef,
      name,
      phone,
      balanceCents: balanceCents as number,
      timezone,
      state,
      consent: parseBool(get('consent'), false),
      optedOut: parseBool(get('optedOut') ?? get('opted_out') ?? get('doNotCall') ?? get('do_not_call'), false),
      disputeOpen: parseBool(get('disputeOpen') ?? get('dispute_open') ?? get('dispute'), false),
      validationNoticeSentAt: parseIsoTimestamp(
        get('validationNoticeSentAt') ?? get('validation_notice_sent_at') ?? get('validationNoticeAt'),
      ),
    },
  };
}

// ── §1692g validation-notice window (SAU-356/F2) ─────────────────────────────

/** §1692g consumer dispute window: 30 days from receipt of the validation notice. */
export const VALIDATION_DISPUTE_WINDOW_DAYS = 30;
const VALIDATION_WINDOW_MS = VALIDATION_DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The operational subset needed to reason about the §1692g window (a full Debtor fits). */
export interface ValidationNoticeTrackable {
  validationNoticeSentAt: string | null;
}

/**
 * Derived end of the §1692g 30-day dispute window (ISO), or null when no notice has been
 * recorded. DERIVED (sent + 30d) — not stored — so there is a single source of truth.
 */
export function disputeWindowEndsAt(debtor: ValidationNoticeTrackable): string | null {
  if (!debtor || !debtor.validationNoticeSentAt) return null;
  const sentMs = Date.parse(debtor.validationNoticeSentAt);
  if (!Number.isFinite(sentMs)) return null;
  return new Date(sentMs + VALIDATION_WINDOW_MS).toISOString();
}

/**
 * True iff `nowMs` falls within the §1692g 30-day dispute window (notice recorded and
 * not yet 30 days elapsed). False when no notice is recorded (window not started) or it
 * has elapsed. Used by reporting to evidence where each debtor sits in the obligation.
 */
export function isWithinValidationWindow(debtor: ValidationNoticeTrackable, nowMs: number): boolean {
  if (!debtor || !debtor.validationNoticeSentAt || !Number.isFinite(nowMs)) return false;
  const sentMs = Date.parse(debtor.validationNoticeSentAt);
  if (!Number.isFinite(sentMs)) return false;
  return nowMs >= sentMs && nowMs < sentMs + VALIDATION_WINDOW_MS;
}

/** Reporting status of a debtor's §1692g validation-notice obligation. */
export type ValidationNoticeStatus = 'not_sent' | 'in_window' | 'window_elapsed';

/** Classify the §1692g obligation state for ops reporting (WS-4 surfacing). */
export function validationNoticeStatus(debtor: ValidationNoticeTrackable, nowMs: number): ValidationNoticeStatus {
  if (!debtor || !debtor.validationNoticeSentAt) return 'not_sent';
  return isWithinValidationWindow(debtor, nowMs) ? 'in_window' : 'window_elapsed';
}

/** Aggregate result of validating a whole synthetic debtor list. */
export interface DebtorIngestValidation {
  total: number;
  valid: NewDebtor[];
  rejected: DebtorRowResult[];
}

/** Validate an array of raw rows; partition into accepted debtors + rejected rows. */
export function validateDebtorRows(
  rows: Array<Record<string, unknown>>,
  clinicId: string,
): DebtorIngestValidation {
  const valid: NewDebtor[] = [];
  const rejected: DebtorRowResult[] = [];
  rows.forEach((raw, i) => {
    const r = validateDebtorRow(raw, clinicId, i + 1);
    if (r.ok && r.debtor) valid.push(r.debtor);
    else rejected.push(r);
  });
  return { total: rows.length, valid, rejected };
}
