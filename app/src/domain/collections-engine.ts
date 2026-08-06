/**
 * Collections compliance engine + cadence scheduler (SAU-332, WS-1) — the core.
 * "The rules ARE the product."
 *
 * `canDialNow(debtor, now, opts)` is the single decision the dialer must ask before
 * every attempt. Every constraint from the board-accepted boundary (SAU-330 §6) is a
 * hard gate HERE, in deterministic server-side logic — never prompt text. The model
 * proposes; the server disposes (same rule that put the clinic's booking logic in the
 * tool, SAU-267).
 *
 * Coordination with WS-2 (SAU-333): this engine consumes WS-2's {@link Debtor} record
 * shape and its {@link DialDecision} value + {@link isValidTimeZone}, all from
 * `@/domain/collections`. WS-2 owns the debtor data layer + the append-only audit
 * ledger; the dialer (WS-3) reads recent attempts FROM that ledger and passes them in
 * as {@link CallAttempt}s — the engine itself does no I/O and holds no PII.
 *
 * Design invariants:
 *  - FAIL CLOSED on any unknown/malformed input (no debtor, bad `now`, unresolved TZ).
 *  - ALL applicable blocking reasons are returned, not just the first — the audit log
 *    and ops UI want every gate a debtor failed.
 *  - The Reg-F 7-in-7 ceiling and 7-day conversation cooldown are CONSTANTS here and are
 *    not reachable from {@link TenantCollectionsConfig}, so no per-tenant value can
 *    loosen them.
 *
 * Scope: pure decision logic. No telephony. Synthetic debtors only (SAU-328 / SAU-330 §8).
 */

import type { Debtor, DialDecision } from '@/domain/collections';
import { isValidTimeZone } from '@/domain/collections';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Hard, un-overridable regulatory ceilings (SAU-330 §3 / §6 #2). Not in config. ──
/** Reg-F §1006.14(b)(2)(i): no more than 7 attempts in 7 consecutive days per debt. */
export const REG_F_MAX_ATTEMPTS = 7;
export const REG_F_WINDOW_DAYS = 7;
/** Reg-F §1006.14(b)(2)(ii): no calling within 7 days of a phone conversation about the debt. */
export const REG_F_CONVERSATION_COOLDOWN_DAYS = 7;

// ── Tenant-tunable defaults (may be made stricter, never looser than the ceilings). ──
const DEFAULT_CADENCE_DAYS = 14; // every-2-weeks
const DEFAULT_WINDOW_OPEN_HOUR = 9; // 9 AM debtor-local
const DEFAULT_WINDOW_CLOSE_HOUR = 17; // 5 PM debtor-local

/**
 * The operational subset of a {@link Debtor} the engine reads. A full `Debtor` is
 * assignable to this (proven in tests), so the dialer passes the record straight
 * through. No PII (name/balance) is touched — only the compliance/scheduling fields.
 */
export interface DialEvaluableDebtor {
  /** IANA zone from account data; engine still fail-closes if it does not resolve. */
  timezone: string;
  /** US state code (or null) — selects the per-state frequency cap (SAU-330 §4). */
  state: string | null;
  /** Prior-express-consent flag; false/absent ⇒ no dial (§6 #4). */
  consent: boolean;
  /** Do-not-call / opt-out; true ⇒ suppressed (§6 #3). */
  optedOut: boolean;
  /** Open §1692g validation dispute pauses calling (§6 #9). */
  disputeOpen: boolean;
  /** Optional phone for the area-code TZ fallback (Debtor.phone is assignable). */
  phone?: string;
}

/**
 * A single prior dial attempt — the raw material for the frequency/cooldown gates.
 * WS-3 derives these from WS-2's audit ledger (one per `call_outcome` row).
 */
export interface CallAttempt {
  /** When the attempt was placed (epoch ms). */
  atMs: number;
  /**
   * True if a live telephone conversation about the debt occurred on this attempt —
   * drives the Reg-F §1006.14(b)(2)(ii) 7-day post-conversation cooldown.
   */
  hadConversation?: boolean;
}

/** A jurisdiction-specific frequency ceiling (SAU-330 §4 state overlays). */
export interface StateCallCap {
  maxAttempts: number;
  windowDays: number;
}

/**
 * Per-tenant tunable policy. Tenants may make the rules STRICTER but can never loosen
 * the hard regulatory ceilings (Reg-F 7-in-7, 7-day cooldown) — those are constants
 * above and are not represented here, so no config value can override them.
 */
export interface TenantCollectionsConfig {
  /** Minimum days between attempts. Default 14 (every-2-weeks, §6 #2). May be lengthened. */
  cadenceDays?: number;
  /** Calling-window open hour (debtor-local, 0–23). Default 9. */
  windowOpenHour?: number;
  /** Calling-window close hour (debtor-local, 0–23, exclusive). Default 17. */
  windowCloseHour?: number;
  /** Per-state stricter caps keyed by 2-letter state code (§4); applied IN ADDITION to Reg-F. */
  stateCaps?: Record<string, StateCallCap>;
  /** Extra observed holidays as 'YYYY-MM-DD' (debtor-local), merged with the built-in set (§6 #7). */
  holidays?: string[];
  /**
   * State licensing allow-list (SAU-330 §4 / §8 item 2) — the 2-letter state codes this
   * tenant is licensed to collect in. The *values* are counsel's call (SAU-354 §9 Q3);
   * this field is the enforcement seam only, and it ships EMPTY.
   *
   * Semantics — fail-closed in BOTH directions (SAU-521). This field is NOT optional in
   * effect: it is the one control in this engine with no floor beneath it, so there is no
   * safe "unconfigured" state.
   *
   *   • CONFIGURED (non-empty): a debtor whose `state` is not in the list — including
   *     `null`/unknown — is hard-BLOCKED with `state_not_licensed`.
   *   • ABSENT or EMPTY: EVERY debtor is hard-BLOCKED with `licensing_unconfigured`.
   *     A tenant with no allow-list is not "ungated", it is "not cleared to dial".
   *
   * Both are PERMANENT blocks (waiting changes nothing), and the two codes are kept
   * distinct on purpose so an operator can tell a *stopped* queue (nobody configured
   * this tenant) from a *filtered* one (this debtor is out of area).
   *
   * Why the engine and not just an onboarding preflight: a preflight is a point-in-time
   * check on a property that must hold continuously. It cannot cover a tenant that passes
   * onboarding and later has its allow-list cleared by a settings edit, a migration, a
   * restore, or a bug. The engine is the single decision point every present and future
   * call site inherits for free.
   *
   * Scope note: this treatment is deliberately NOT generalized to `stateCaps` or
   * `holidays`. Those are stricter-only layers sitting above an enforced floor (the
   * hard-constant Reg-F 7-in-7, and DEFAULT_US_HOLIDAYS respectively), so unconfigured is
   * already safe for them. Only `allowedStates` has nothing underneath it.
   */
  allowedStates?: string[];
}

/**
 * Machine-readable block codes — one per guardrail this WS owns. WS-2's audit ledger
 * records these verbatim in its `reason` field, so they are a stable contract: add,
 * don't rename.
 */
export type DialBlockCode =
  | 'unknown_input' // fail-closed: missing/malformed debtor or `now`
  | 'unknown_timezone' // fail-closed: debtor TZ could not be resolved (§6 #6)
  | 'opted_out' // do-not-call / revocation on file (§6 #3)
  | 'no_consent' // no prior-express-consent record (§6 #4)
  | 'dispute_open' // open §1692g validation dispute pauses calling (§6 #9)
  | 'state_not_licensed' // debtor state absent from the tenant licensing allow-list (default-deny, §4 / §8 #2)
  | 'licensing_unconfigured' // NO licensing allow-list configured for this tenant — fail-closed (SAU-521)
  | 'non_working_day' // weekend (working-days-only window, §6 #1)
  | 'holiday' // observed holiday (§6 #7)
  | 'outside_calling_window' // outside 9 AM–5 PM debtor-local (§6 #1)
  | 'cadence_not_elapsed' // inside the per-tenant min interval (default 2 weeks, §6 #2)
  | 'reg_f_7_in_7' // Reg-F §1006.14(b)(2)(i) hard ceiling — un-overridable (§6 #2)
  | 'state_cap' // per-state stricter cap exceeded (§4)
  | 'conversation_cooldown'; // Reg-F 7-day post-conversation cooldown (§6 #2)

/** A single reason a dial was blocked, with a human-readable explanation. */
export interface DialBlockReason {
  code: DialBlockCode;
  message: string;
}

/**
 * The engine's verdict. `decision` is WS-2's {@link DialDecision} ('ALLOW' | 'BLOCK'),
 * so the result drops straight into the audit ledger; ALLOW iff `reasons` is empty.
 * ALL applicable blocking reasons are returned (not just the first).
 */
export interface DialEvaluation {
  decision: DialDecision;
  reasons: DialBlockReason[];
}

/** Options carrying the call history + tenant policy the gates need. */
export interface CanDialOptions {
  /** Prior attempts for this debtor (from WS-2's audit ledger), for the frequency gates. */
  attempts?: CallAttempt[];
  /** Per-tenant policy (stricter-only overrides). */
  config?: TenantCollectionsConfig;
}

// ── Time-zone + holiday helpers (debtor-local, fail-closed; §6 #6 / #7) ──────────

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Representative NANP area-code → IANA zone map for the area-code fallback (§6 #6).
 * Deliberately a SMALL subset for the synthetic POC; anything unlisted resolves to
 * null → fail-closed, so the partial map is conservative, not risky.
 */
const AREA_CODE_TZ: Record<string, string> = {
  '212': 'America/New_York', // NYC
  '202': 'America/New_York', // DC
  '404': 'America/New_York', // Atlanta
  '617': 'America/New_York', // Boston (MA)
  '305': 'America/New_York', // Miami
  '215': 'America/New_York', // Philadelphia
  '312': 'America/Chicago', // Chicago
  '214': 'America/Chicago', // Dallas
  '713': 'America/Chicago', // Houston
  '612': 'America/Chicago', // Minneapolis
  '303': 'America/Denver', // Denver
  '602': 'America/Phoenix', // Phoenix (no DST)
  '415': 'America/Los_Angeles', // San Francisco
  '213': 'America/Los_Angeles', // Los Angeles
  '206': 'America/Los_Angeles', // Seattle
  '702': 'America/Los_Angeles', // Las Vegas
  '907': 'America/Anchorage', // Alaska
  '808': 'Pacific/Honolulu', // Hawaii
};

/** US federal holidays (observed dates), 'YYYY-MM-DD'. POC horizon: 2026–2027 (§6 #7). */
export const DEFAULT_US_HOLIDAYS: ReadonlySet<string> = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24',
]);

/** True if `localDateStr` ('YYYY-MM-DD') is an observed holiday (built-in + tenant extra). */
export function isHoliday(localDateStr: string, extra?: readonly string[]): boolean {
  return DEFAULT_US_HOLIDAYS.has(localDateStr) || (!!extra && extra.includes(localDateStr));
}

/** Extract the 3-digit NANP area code from a phone string, or null. */
export function areaCodeOf(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

/** Resolve a debtor's IANA zone: explicit account TZ first, then area-code fallback; else null. */
export function resolveTimeZone(debtor: Pick<DialEvaluableDebtor, 'timezone' | 'phone'>): string | null {
  if (isValidTimeZone(debtor.timezone)) return debtor.timezone;
  const ac = areaCodeOf(debtor.phone);
  if (ac) {
    const tz = AREA_CODE_TZ[ac];
    if (isValidTimeZone(tz)) return tz;
  }
  return null;
}

/** Debtor-local wall-clock decomposition of an epoch-ms instant. */
export interface LocalParts {
  /** 0=Sunday … 6=Saturday. */
  weekday: number;
  /** Local hour, 0–23. */
  hour: number;
  /** Local minute, 0–59. */
  minute: number;
  /** Local calendar date as 'YYYY-MM-DD' (for holiday matching). */
  dateStr: string;
}

/** Decompose an instant into debtor-local parts; null if `tz` invalid or `ms` not finite. */
export function getLocalParts(ms: number, tz: string): LocalParts | null {
  if (!Number.isFinite(ms) || !isValidTimeZone(tz)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23', // 00–23, so midnight is 00 not 24
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = WEEKDAY_INDEX[get('weekday')];
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return { weekday, hour, minute, dateStr: `${get('year')}-${get('month')}-${get('day')}` };
  } catch {
    return null;
  }
}

// ── Frequency helpers ────────────────────────────────────────────────────────

/** Count attempts whose timestamp falls within `windowDays` before `nowMs`. */
function attemptsInWindow(attempts: CallAttempt[], nowMs: number, windowDays: number): number {
  const cutoff = nowMs - windowDays * DAY_MS;
  return attempts.filter((a) => Number.isFinite(a.atMs) && a.atMs > cutoff && a.atMs <= nowMs).length;
}

/** Most recent attempt timestamp at or before `nowMs`, or null. */
function lastAttemptMs(attempts: CallAttempt[], nowMs: number): number | null {
  let last: number | null = null;
  for (const a of attempts) {
    if (Number.isFinite(a.atMs) && a.atMs <= nowMs && (last === null || a.atMs > last)) last = a.atMs;
  }
  return last;
}

function reason(code: DialBlockCode, message: string): DialBlockReason {
  return { code, message };
}

/**
 * The full compliance decision for one debtor at one instant. Returns ALLOW only when
 * EVERY gate passes; otherwise BLOCK with the complete set of failing reasons.
 */
export function canDialNow(
  debtor: DialEvaluableDebtor | null | undefined,
  nowMs: number,
  opts: CanDialOptions = {},
): DialEvaluation {
  const config = opts.config ?? {};
  const attempts = opts.attempts ?? [];
  const reasons: DialBlockReason[] = [];

  // ── Fail-closed input validation (AC: fail-closed on any unknown input). ──
  if (!debtor || typeof debtor !== 'object') {
    return { decision: 'BLOCK', reasons: [reason('unknown_input', 'No debtor record supplied; refusing to dial.')] };
  }
  if (!Number.isFinite(nowMs)) {
    return { decision: 'BLOCK', reasons: [reason('unknown_input', 'Invalid current time supplied; refusing to dial.')] };
  }

  // ── Suppression / consent / dispute gates (do not require a time zone). ──

  // §6 #3 Do-not-call / opt-out: revocation must be honored ≤10 business days; we block
  // immediately on record, which is strictly inside that SLA.
  if (debtor.optedOut === true) {
    reasons.push(reason('opted_out', 'Debtor has opted out / is on the do-not-call list; suppressed.'));
  }

  // §6 #4 Consent gate: dial only with a recorded prior-express-consent flag.
  if (debtor.consent !== true) {
    reasons.push(reason('no_consent', 'No prior-express-consent record on file for this number.'));
  }

  // §6 #9 Validation-notice / dispute: an open §1692g dispute pauses calling.
  if (debtor.disputeOpen === true) {
    reasons.push(reason('dispute_open', 'An open validation dispute is pausing calls to this debtor.'));
  }

  // §4 / §8 #2 State licensing allow-list — fail-closed in both directions (SAU-521).
  // Unlike every other config-driven guardrail here, this one has NO enforced floor
  // beneath it, so an unconfigured tenant cannot be allowed through: no allow-list means
  // no authority to dial anyone, not "gate disabled". Both outcomes are classed PERMANENT
  // (waiting changes nothing) and carry DISTINCT codes so a stopped queue is
  // distinguishable from a filtered one.
  const allowedStates = config.allowedStates;
  if (!allowedStates || allowedStates.length === 0) {
    reasons.push(
      reason(
        'licensing_unconfigured',
        'No licensing allow-list is configured for this tenant; refusing to dial. ' +
          'Set the collections policy `allowedStates` to the states this tenant is licensed to collect in.',
      ),
    );
  } else {
    const licensed = new Set(allowedStates.map((s) => s.toUpperCase()));
    const debtorState = debtor.state ? debtor.state.toUpperCase() : null;
    if (debtorState === null || !licensed.has(debtorState)) {
      reasons.push(
        reason(
          'state_not_licensed',
          debtorState === null
            ? 'Debtor state is unknown; not in the licensing allow-list (default-deny).'
            : `Debtor state ${debtorState} is not in the tenant licensing allow-list (default-deny).`,
        ),
      );
    }
  }

  // ── Calling-window gates require the debtor's local time → resolve TZ (§6 #6). ──
  const tz = resolveTimeZone(debtor);
  const local = tz ? getLocalParts(nowMs, tz) : null;
  if (!local) {
    // §6 #6 fail-closed: unknown/unresolvable time zone → never dial.
    reasons.push(reason('unknown_timezone', 'Could not resolve debtor local time zone; failing closed.'));
  } else {
    // §6 #1 Working days only (Mon–Fri).
    if (local.weekday === 0 || local.weekday === 6) {
      reasons.push(reason('non_working_day', 'Calls are only placed on working days (Mon–Fri).'));
    }
    // §6 #7 Holiday calendar.
    if (isHoliday(local.dateStr, config.holidays)) {
      reasons.push(reason('holiday', `No calls on observed holiday (${local.dateStr}).`));
    }
    // §6 #1 9 AM–5 PM debtor-local window. 09:00–09:59 is in-window; 17:00 onward is out.
    const openHour = config.windowOpenHour ?? DEFAULT_WINDOW_OPEN_HOUR;
    const closeHour = config.windowCloseHour ?? DEFAULT_WINDOW_CLOSE_HOUR;
    if (local.hour < openHour || local.hour >= closeHour) {
      reasons.push(
        reason('outside_calling_window', `Outside the ${openHour}:00–${closeHour}:00 debtor-local calling window (local hour ${local.hour}).`),
      );
    }
  }

  // ── Frequency gates (§6 #2). Each is independent; the strictest blocks. ──

  // Reg-F 7-in-7 HARD ceiling — un-overridable, checked even if a looser tenant cadence would allow it.
  if (attemptsInWindow(attempts, nowMs, REG_F_WINDOW_DAYS) >= REG_F_MAX_ATTEMPTS) {
    reasons.push(reason('reg_f_7_in_7', `Reg-F ceiling reached: ${REG_F_MAX_ATTEMPTS} attempts within ${REG_F_WINDOW_DAYS} days.`));
  }

  // Per-tenant cadence (default every-2-weeks): minimum gap since the last attempt.
  const cadenceDays = Math.max(0, config.cadenceDays ?? DEFAULT_CADENCE_DAYS);
  const last = lastAttemptMs(attempts, nowMs);
  if (cadenceDays > 0 && last !== null && nowMs - last < cadenceDays * DAY_MS) {
    reasons.push(reason('cadence_not_elapsed', `Within the ${cadenceDays}-day minimum interval since the last attempt.`));
  }

  // Per-state stricter cap (§4), if one is configured for the debtor's state.
  const stateCap = debtor.state ? config.stateCaps?.[debtor.state.toUpperCase()] : undefined;
  if (stateCap && attemptsInWindow(attempts, nowMs, stateCap.windowDays) >= stateCap.maxAttempts) {
    reasons.push(
      reason('state_cap', `State cap reached for ${debtor.state}: ${stateCap.maxAttempts} attempts within ${stateCap.windowDays} days.`),
    );
  }

  // Reg-F 7-day post-conversation cooldown — un-overridable.
  const cooldownCutoff = nowMs - REG_F_CONVERSATION_COOLDOWN_DAYS * DAY_MS;
  if (attempts.some((a) => a.hadConversation === true && Number.isFinite(a.atMs) && a.atMs > cooldownCutoff && a.atMs <= nowMs)) {
    reasons.push(
      reason('conversation_cooldown', `Within the ${REG_F_CONVERSATION_COOLDOWN_DAYS}-day cooldown after a phone conversation about the debt.`),
    );
  }

  return reasons.length === 0 ? { decision: 'ALLOW', reasons: [] } : { decision: 'BLOCK', reasons };
}

/** Convenience: true iff the debtor may be dialed at `nowMs`. */
export function isDialAllowed(debtor: DialEvaluableDebtor | null | undefined, nowMs: number, opts?: CanDialOptions): boolean {
  return canDialNow(debtor, nowMs, opts).decision === 'ALLOW';
}

// ── Next-eligible-dial scheduler (SAU-335, WS-4 — the dashboard "when next" answer) ──

/**
 * Block codes that are NOT time-resolvable: the debtor's *state* must change first
 * (an opt-out cleared, consent recorded, dispute closed, a resolvable TZ, a licensed
 * state). Waiting does nothing, so the forward search short-circuits and the UI shows
 * "suppressed", not a date.
 */
const PERMANENT_BLOCK_CODES: ReadonlySet<DialBlockCode> = new Set([
  'unknown_input',
  'unknown_timezone',
  'opted_out',
  'no_consent',
  'dispute_open',
  'state_not_licensed',
  'licensing_unconfigured',
]);

/** Minutes-granularity of the forward scan. The calling window is hours wide, so a
 *  15-minute step can never skip over an open window. */
const NEXT_DIAL_STEP_MS = 15 * 60 * 1000;
/** Search horizon — comfortably past the every-2-weeks default cadence + a holiday run. */
const NEXT_DIAL_HORIZON_MS = 30 * DAY_MS;

/** The next-eligible-dial verdict for one debtor, derived from `canDialNow` itself. */
export interface NextDialResult {
  /** May the debtor be dialed at `fromMs`? */
  allowedNow: boolean;
  /** Epoch ms of the next permitted dial, or null (permanent suppression or none in horizon). */
  nextMs: number | null;
  /** True when blocked by a state-based suppression (opt-out / consent / dispute / unresolved TZ). */
  permanentBlock: boolean;
  /** The reasons the dial is blocked at `fromMs` ([] when `allowedNow`). */
  reasons: DialBlockReason[];
}

/**
 * The earliest instant at/after `fromMs` this debtor may be dialed, computed from the
 * SAME {@link canDialNow} gates the dialer enforces — never a guess (SAU-335 AC). The
 * dashboard renders this as "Eligible now" / "Next: <time>" / "Suppressed".
 *
 *  - allowed now             → `{ allowedNow: true, nextMs: fromMs }`
 *  - state-based suppression → `{ permanentBlock: true, nextMs: null }` (no date — state must change)
 *  - time/frequency block    → scans forward at 15-min steps to the next ALLOW within 30 days
 *  - no opening in horizon    → `{ nextMs: null }`
 */
export function nextEligibleDial(
  debtor: DialEvaluableDebtor | null | undefined,
  fromMs: number,
  opts: CanDialOptions = {},
): NextDialResult {
  const current = canDialNow(debtor, fromMs, opts);
  if (current.decision === 'ALLOW') {
    return { allowedNow: true, nextMs: fromMs, permanentBlock: false, reasons: [] };
  }
  const permanentBlock = current.reasons.some((r) => PERMANENT_BLOCK_CODES.has(r.code));
  if (permanentBlock || !Number.isFinite(fromMs)) {
    return { allowedNow: false, nextMs: null, permanentBlock, reasons: current.reasons };
  }
  // Time/frequency block only — walk forward to the next opening the engine permits.
  for (let t = fromMs + NEXT_DIAL_STEP_MS; t <= fromMs + NEXT_DIAL_HORIZON_MS; t += NEXT_DIAL_STEP_MS) {
    const at = canDialNow(debtor, t, opts);
    if (at.decision === 'ALLOW') {
      return { allowedNow: false, nextMs: t, permanentBlock: false, reasons: current.reasons };
    }
    // Defensive: if a permanent suppression appears mid-scan, stop (no date can be given).
    if (at.reasons.some((r) => PERMANENT_BLOCK_CODES.has(r.code))) break;
  }
  return { allowedNow: false, nextMs: null, permanentBlock: false, reasons: current.reasons };
}
