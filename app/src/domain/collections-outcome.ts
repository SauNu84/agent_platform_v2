/**
 * Collections OUTCOME model (SAU-335, WS-4) — the result of one call attempt against a
 * synthetic debtor, persisted per debtor + per attempt, plus the helpers that map an
 * outcome to the compliance facts WS-1's frequency gates and WS-2's audit ledger need.
 *
 * Parent: SAU-328 (Collections Agent, synthetic POC). SCOPE: synthetic debtors only —
 * nothing here can place a real call.
 *
 * This is the collections analogue of the clinic `ClinicOutcome` model (SAU-267/301).
 * The dialer (WS-3, SAU-334) records ONE of these per attempt; the per-tenant ops
 * dashboard (this WS) aggregates them; and WS-1's engine re-derives its frequency
 * window from the {@link CallAttempt}s these rows project to. The record itself is pure
 * data (no PII): the debtor's name/phone live encrypted on the `debtor` row — an
 * attempt only references the debtor by id.
 */

/**
 * The disposition of one outbound attempt. The first six are real call results from the
 * dialer; `blocked_by_compliance` means WS-1's {@link import('./collections-engine').canDialNow}
 * REFUSED the dial (no call was placed) and the row carries the WS-1 block reason code.
 * Stable contract for the audit ledger + dashboard: add, don't rename.
 */
export type CollectionsOutcome =
  | 'contacted' //          reached the debtor — a live conversation about the debt
  | 'promised_to_pay' //    reached + the debtor committed to pay (a contact + conversation)
  | 'no_answer' //          rang out / busy — no contact, an attempt was still placed
  | 'voicemail_left' //     left a compliant voicemail — no live contact
  | 'opted_out' //          debtor asked to stop during the call (do-not-call recorded)
  | 'dispute_raised' //     debtor disputed the debt during the call (§1692g)
  | 'blocked_by_compliance'; // WS-1 refused the dial; never placed — carries the block reason

/** Every outcome value, for enum-style iteration / validation. */
export const COLLECTIONS_OUTCOMES: readonly CollectionsOutcome[] = [
  'contacted',
  'promised_to_pay',
  'no_answer',
  'voicemail_left',
  'opted_out',
  'dispute_raised',
  'blocked_by_compliance',
];

/** Fields to record one call attempt. The server stamps id/createdAt. */
export interface NewCallAttempt {
  /** Owning lender/tenant id (reuses the `clinic` tenant primitive). */
  clinicId: string;
  /** FK to the debtor row. */
  debtorId: string;
  /** Debtor id / external_ref for the audit ledger — an identifier, NEVER PII. */
  debtorRef: string;
  outcome: CollectionsOutcome;
  /** WS-1 block reason code when `outcome === 'blocked_by_compliance'`, else null. */
  blockReason?: string | null;
  /** All WS-1 block reason codes (when blocked) — recorded in the audit `refs` (counts/ids only). */
  blockReasons?: string[];
  /** When the attempt was placed (epoch ms); defaults to now. */
  attemptedAtMs?: number;
  /** Synthetic POC marker (always true in this phase). */
  simulated?: boolean;
}

/** A persisted call-attempt outcome row. */
export interface CallAttemptRecord {
  id: string;
  clinicId: string;
  debtorId: string;
  outcome: CollectionsOutcome;
  /** Whether a live conversation about the debt occurred (drives the Reg-F cooldown). */
  hadConversation: boolean;
  /** WS-1 block reason code for a `blocked_by_compliance` row, else null. */
  blockReason: string | null;
  attemptedAt: string; // ISO
  simulated: boolean;
  createdAt: string; // ISO
}

/**
 * Outcomes that mean a live phone CONVERSATION about the debt occurred. When projected
 * to a WS-1 {@link import('./collections-engine').CallAttempt} these set `hadConversation`,
 * which arms the Reg-F §1006.14(b)(2)(ii) 7-day post-conversation cooldown.
 */
const CONVERSATION_OUTCOMES: ReadonlySet<CollectionsOutcome> = new Set([
  'contacted',
  'promised_to_pay',
  'opted_out',
  'dispute_raised',
]);

/** True if this outcome reflects a live conversation about the debt. */
export function outcomeHadConversation(outcome: CollectionsOutcome): boolean {
  return CONVERSATION_OUTCOMES.has(outcome);
}

/**
 * Did this outcome consume a dialing ATTEMPT (a call was actually placed)? A compliance
 * BLOCK never places a call, so it must NOT count toward WS-1's frequency caps — only
 * placed attempts project to {@link import('./collections-engine').CallAttempt}.
 */
export function outcomeWasPlaced(outcome: CollectionsOutcome): boolean {
  return outcome !== 'blocked_by_compliance';
}
