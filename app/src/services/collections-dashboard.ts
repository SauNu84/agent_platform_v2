/**
 * Per-tenant collections ops dashboard read-model (SAU-335, WS-4).
 *
 * Aggregates, for ONE lender, the WS-4 call-attempt outcomes + the WS-2 compliance
 * audit ledger into the operational view an ops user needs: cadence status, the next
 * eligible-dial time, the suppression / opt-out list, and compliance-block counts —
 * plus a read-only window onto the guardrail-10 audit trail so they can see *why* a
 * debtor was or wasn't called.
 *
 * The reuse contract:
 *   • Tenant isolation comes from the RLS-scoped store methods (a caller only ever
 *     aggregates the lender bound to app.clinic_id) — the same SAU-275/301 foundation.
 *   • "Next eligible dial" is NOT a guess: it is computed by WS-1's own
 *     {@link nextEligibleDial} over the SAME placed-attempt history the dialer's
 *     frequency gates read back (SAU-335 AC).
 *
 * Synthetic debtors only (SAU-328 / SAU-330 §8).
 */
import type { Store } from '@/db/store';
import type { Debtor } from '@/domain/collections';
import type { CallAttemptRecord, CollectionsOutcome } from '@/domain/collections-outcome';
import { COLLECTIONS_OUTCOMES, outcomeWasPlaced } from '@/domain/collections-outcome';
import {
  nextEligibleDial,
  type CallAttempt,
  type TenantCollectionsConfig,
} from '@/domain/collections-engine';

/** Per-debtor cadence + next-eligible-dial row for the dashboard. */
export interface DebtorCadenceRow {
  debtorId: string;
  externalRef: string;
  state: string | null;
  consent: boolean;
  optedOut: boolean;
  disputeOpen: boolean;
  /** Placed attempts on file (excludes compliance blocks — no call was placed). */
  attempts: number;
  lastAttemptAt: string | null;
  lastOutcome: CollectionsOutcome | null;
  /** Eligible to dial right now (WS-1)? */
  allowedNow: boolean;
  /** ISO of the next permitted dial, or null (suppressed / none within horizon). */
  nextEligibleAt: string | null;
  /** True when blocked by a state-based suppression (opt-out / consent / dispute / TZ). */
  permanentBlock: boolean;
  /** Current WS-1 block reason codes ([] when eligible now). */
  blockReasons: string[];
}

/** One {reason → count} compliance-block tally from the audit ledger. */
export interface ComplianceBlockCount {
  reason: string;
  count: number;
}

/** A read-only compliance audit row for the UI (guardrail 10). */
export interface CollectionsAuditRow {
  ts: string;
  eventType: string;
  decision: string | null;
  reason: string | null;
  debtorRef: string;
  actorLabel: string;
}

export interface CollectionsDashboardMetrics {
  clinicId: string;
  totalDebtors: number;
  /** Debtors eligible to dial right now (WS-1). */
  eligibleNow: number;
  /** Debtors currently suppressed (opted out OR open dispute). */
  suppressed: number;
  /** Placed attempts (excludes compliance blocks). */
  totalAttempts: number;
  /** Outcome → count over all attempts (every enum value present, 0 if none). */
  outcomes: Record<CollectionsOutcome, number>;
  /** (contacted + promised_to_pay) / placed attempts. */
  contactRate: number;
  /** promised_to_pay count. */
  promisedToPay: number;
  /** Attempts the engine refused (outcome = blocked_by_compliance). */
  blockedAttempts: number;
  /** dial_decision BLOCK rows in the ledger, grouped by reason (desc). */
  complianceBlocks: ComplianceBlockCount[];
  /** Per-debtor cadence / next-eligible-dial (all debtors, newest first). */
  cadence: DebtorCadenceRow[];
  /** The opt-out / dispute suppression list (subset of cadence). */
  suppressionList: DebtorCadenceRow[];
  /** Most-recent compliance audit events (read-only trail). */
  recentAudit: CollectionsAuditRow[];
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/** Project a debtor's placed attempts to WS-1 {@link CallAttempt}s (blocks never placed → excluded). */
function toCallAttempts(attempts: CallAttemptRecord[]): CallAttempt[] {
  return attempts
    .filter((a) => outcomeWasPlaced(a.outcome))
    .map((a) => ({ atMs: Date.parse(a.attemptedAt), hadConversation: a.hadConversation }))
    .filter((a) => Number.isFinite(a.atMs));
}

/** Build the per-tenant dashboard metrics. `nowMs` anchors the next-eligible-dial math. */
export async function getCollectionsDashboard(
  store: Store,
  clinicId: string,
  nowMs: number,
  config: TenantCollectionsConfig = {},
  recentAuditLimit = 25,
): Promise<CollectionsDashboardMetrics> {
  const debtors = await store.listDebtorsForClinic(clinicId);
  const allAttempts = await store.listCallAttemptsForClinic(clinicId);
  const auditLog = await store.listCollectionsAudit({ clinicId, limit: 500 });

  // Group attempts by debtor.
  const byDebtor = new Map<string, CallAttemptRecord[]>();
  for (const a of allAttempts) {
    const list = byDebtor.get(a.debtorId) ?? [];
    list.push(a);
    byDebtor.set(a.debtorId, list);
  }

  const cadence: DebtorCadenceRow[] = debtors.map((d: Debtor) => {
    const attemptsForDebtor = (byDebtor.get(d.id) ?? []).slice().sort((x, y) => y.attemptedAt.localeCompare(x.attemptedAt));
    const placed = attemptsForDebtor.filter((a) => outcomeWasPlaced(a.outcome));
    const next = nextEligibleDial(d, nowMs, { attempts: toCallAttempts(attemptsForDebtor), config });
    return {
      debtorId: d.id,
      externalRef: d.externalRef,
      state: d.state,
      consent: d.consent,
      optedOut: d.optedOut,
      disputeOpen: d.disputeOpen,
      attempts: placed.length,
      lastAttemptAt: placed[0]?.attemptedAt ?? null,
      lastOutcome: attemptsForDebtor[0]?.outcome ?? null,
      allowedNow: next.allowedNow,
      nextEligibleAt: next.nextMs != null ? new Date(next.nextMs).toISOString() : null,
      permanentBlock: next.permanentBlock,
      blockReasons: next.reasons.map((r) => r.code),
    };
  });

  // Outcome tallies (every enum value present).
  const outcomes = Object.fromEntries(COLLECTIONS_OUTCOMES.map((o) => [o, 0])) as Record<CollectionsOutcome, number>;
  for (const a of allAttempts) outcomes[a.outcome] += 1;

  const placedAttempts = allAttempts.filter((a) => outcomeWasPlaced(a.outcome));
  const contacts = outcomes.contacted + outcomes.promised_to_pay;

  // Compliance-block counts from the ledger (the guardrail-10 source of truth).
  const blockTally = new Map<string, number>();
  for (const row of auditLog) {
    if (row.eventType === 'dial_decision' && row.decision === 'BLOCK') {
      const reason = row.reason ?? 'unknown';
      blockTally.set(reason, (blockTally.get(reason) ?? 0) + 1);
    }
  }
  const complianceBlocks = [...blockTally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const suppressionList = cadence.filter((c) => c.optedOut || c.disputeOpen);

  return {
    clinicId,
    totalDebtors: debtors.length,
    eligibleNow: cadence.filter((c) => c.allowedNow).length,
    suppressed: suppressionList.length,
    totalAttempts: placedAttempts.length,
    outcomes,
    contactRate: rate(contacts, placedAttempts.length),
    promisedToPay: outcomes.promised_to_pay,
    blockedAttempts: outcomes.blocked_by_compliance,
    complianceBlocks,
    cadence,
    suppressionList,
    recentAudit: auditLog.slice(0, recentAuditLimit).map((r) => ({
      ts: r.ts,
      eventType: r.eventType,
      decision: r.decision,
      reason: r.reason,
      debtorRef: r.debtorRef,
      actorLabel: r.actorLabel,
    })),
  };
}
