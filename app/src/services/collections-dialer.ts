/**
 * Collections outbound dialer (SAU-334, WS-3) — voice orchestration for the synthetic
 * collections agent. This is where the three WS deliverables meet:
 *
 *   • WS-1 (SAU-332) — `canDialNow` is called BEFORE every origination. A BLOCK
 *     decision returns before the origination seam is ever reached. The dialer is
 *     architecturally incapable of dialing outside the compliance engine's decision
 *     (a defensive re-check guards the origination call too).
 *   • WS-2 (SAU-333) — every dial decision AND every call outcome is appended to the
 *     tamper-evident compliance ledger (`recordCollectionsAudit`). `refs` carries
 *     counts/status only — NEVER PII (no name/phone/balance).
 *   • WS-3 (this WS) — guardrail 5 (required disclosure injected at the start of every
 *     connected call) and guardrail 8 (limited-content voicemail, screened fail-closed)
 *     from {@link module:domain/collections-voice}, placed over the outbound origination
 *     seam (mock by default; live Twilio only behind the SAU-331 go-live gate).
 *
 * SCOPE: synthetic debtors / owned test number only (SAU-328). The default origination
 * is the simulated dialer; a real consumer call is impossible until the go-live gate is
 * confirmed (see outbound-origination.ts).
 */
import type { Store } from '@/db/store';
import type { Debtor, DialDecision, CollectionsAuditRecord } from '@/domain/collections';
import {
  canDialNow,
  type CallAttempt,
  type DialBlockReason,
  type TenantCollectionsConfig,
} from '@/domain/collections-engine';
import {
  COLLECTIONS_REQUIRED_DISCLOSURE,
  buildVoicemailScript,
  buildCollectionsAgentInstructions,
  assertNoDebtDetails,
} from '@/domain/collections-voice';
import {
  resolveOutboundDialer,
  type OutboundDialer,
  type OutboundCallResult,
} from '@/services/telephony/outbound-origination';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CollectionsDialerDeps {
  store: Store;
  /** Origination backend; defaults to the env-resolved dialer (mock unless go-live). */
  origination?: OutboundDialer;
  /** Per-tenant policy (stricter-only). Passed straight to `canDialNow`. */
  config?: TenantCollectionsConfig;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Owned caller-id (E.164) we dial FROM. */
  fromNumber?: string;
  /** Collection agency name (for the persona + voicemail). Non-PII. */
  agencyName?: string;
  /** Agency callback number for the limited-content voicemail. Non-PII. */
  callbackNumber?: string;
  /** Public wss:// bridge URL the vendor should stream to (live path only). */
  bridgeWsUrl?: string;
}

/** Outcome of one `attemptDial` — the audit rows it wrote, plus what happened. */
export interface DialAttemptResult {
  debtorRef: string;
  clinicId: string;
  /** WS-1's verdict for this attempt. */
  decision: DialDecision;
  /** All blocking reasons (empty on ALLOW). */
  reasons: DialBlockReason[];
  /** True iff origination was actually attempted (i.e. decision was ALLOW). */
  originated: boolean;
  /** The origination result, or null when blocked / not originated. */
  call: OutboundCallResult | null;
  /** The disclosure played first — non-null IFF a call connected (guardrail 5). */
  disclosure: string | null;
  /** The limited-content voicemail script — non-null IFF the call went to voicemail. */
  voicemailScript: string | null;
}

const DEFAULT_AGENCY = 'Acme Recovery Services';
const DEFAULT_CALLBACK = '+18005550100';
const DEFAULT_FROM = '+18005550100';

/**
 * The outbound collections dialer. One instance per tenant context is fine; the store's
 * RLS scopes reads/writes to the bound actor's tenant.
 */
export class CollectionsDialer {
  private store: Store;
  private origination: OutboundDialer;
  private config?: TenantCollectionsConfig;
  private now: () => number;
  private fromNumber: string;
  private agencyName: string;
  private callbackNumber: string;
  private bridgeWsUrl?: string;

  constructor(deps: CollectionsDialerDeps) {
    this.store = deps.store;
    this.origination = deps.origination ?? resolveOutboundDialer();
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.fromNumber = deps.fromNumber ?? DEFAULT_FROM;
    this.agencyName = deps.agencyName ?? DEFAULT_AGENCY;
    this.callbackNumber = deps.callbackNumber ?? DEFAULT_CALLBACK;
    this.bridgeWsUrl = deps.bridgeWsUrl;
  }

  /**
   * Attempt to dial one debtor. ALWAYS asks WS-1 first; on BLOCK it records the decision
   * and returns WITHOUT originating. On ALLOW it records the decision, originates over
   * the seam (disclosure injected first; limited-content voicemail if unanswered), and
   * records the call outcome — all in the append-only compliance ledger.
   */
  async attemptDial(debtorId: string): Promise<DialAttemptResult> {
    const debtor = await this.store.getDebtor(debtorId);
    const nowMs = this.now();

    // Fail closed if the debtor cannot be loaded — canDialNow(null) BLOCKs with
    // 'unknown_input'; we still log the decision against the requested id.
    const debtorRef = debtor?.id ?? debtorId;
    const clinicId = debtor?.clinicId;

    const attempts = debtor ? await this.priorAttempts(debtor) : [];
    const evaluation = canDialNow(debtor, nowMs, { attempts, config: this.config });
    const reasonCodes = evaluation.reasons.map((r) => r.code);

    // ── Always record the dial decision (counts/codes only — never PII). ──
    if (clinicId) {
      await this.store.recordCollectionsAudit({
        clinicId,
        debtorRef,
        eventType: 'dial_decision',
        decision: evaluation.decision,
        reason: reasonCodes.join(',') || null,
        refs: { attemptsLast7: attemptsInLastDays(attempts, nowMs, 7), reasonCount: reasonCodes.length },
      });
    }

    // ── BLOCK ⇒ origination is unreachable. This is the WS-1 gate. ──
    if (evaluation.decision === 'BLOCK' || !debtor || !clinicId) {
      return {
        debtorRef,
        clinicId: clinicId ?? '',
        decision: evaluation.decision,
        reasons: evaluation.reasons,
        originated: false,
        call: null,
        disclosure: null,
        voicemailScript: null,
      };
    }

    // ── ALLOW ⇒ build the server-fixed scripts and originate. ──
    const disclosure = COLLECTIONS_REQUIRED_DISCLOSURE;
    const voicemailScript = buildVoicemailScript({
      agencyName: this.agencyName,
      callbackNumber: this.callbackNumber,
    });
    // Guardrail 8 fail-closed screen: a misbuilt voicemail can never be left.
    assertNoDebtDetails(voicemailScript);
    const agentInstructions = buildCollectionsAgentInstructions({ agencyName: this.agencyName });

    // Defense in depth: never reach origination unless the engine ALLOWs right now.
    if (canDialNow(debtor, this.now(), { attempts, config: this.config }).decision !== 'ALLOW') {
      throw new Error('refusing to originate: compliance engine did not ALLOW');
    }

    const call = await this.origination.originate({
      to: debtor.phone,
      from: this.fromNumber,
      callId: `${clinicId}:${debtorRef}:${nowMs}`,
      bridgeWsUrl: this.bridgeWsUrl,
      disclosure,
      voicemailScript,
      agentInstructions,
    });

    // ── Record the call outcome (status + conversation flag; no PII). ──
    await this.store.recordCollectionsAudit({
      clinicId,
      debtorRef,
      eventType: 'call_outcome',
      decision: null,
      reason: call.status,
      refs: { status: call.status, hadConversation: call.hadConversation, voicemail: call.status === 'voicemail' },
    });

    return {
      debtorRef,
      clinicId,
      decision: 'ALLOW',
      reasons: [],
      originated: true,
      call,
      disclosure: call.status === 'connected' ? disclosure : null,
      voicemailScript: call.status === 'voicemail' ? voicemailScript : null,
    };
  }

  /**
   * Attempt every debtor for a lender/tenant once, in order. Each debtor is independently
   * gated by WS-1; the batch is just a convenience for the cadence run / ops dashboard
   * (WS-5). Returns one result per debtor.
   */
  async attemptDialForClinic(clinicId: string): Promise<DialAttemptResult[]> {
    const debtors = await this.store.listDebtorsForClinic(clinicId);
    const results: DialAttemptResult[] = [];
    for (const d of debtors) {
      results.push(await this.attemptDial(d.id));
    }
    return results;
  }

  /**
   * Derive the WS-1 `CallAttempt[]` for a debtor from WS-2's audit ledger: one entry per
   * recorded `call_outcome`, with `hadConversation` lifted from its `refs`. This is the
   * frequency/cooldown raw material — the engine itself does no I/O.
   */
  private async priorAttempts(debtor: Debtor): Promise<CallAttempt[]> {
    const rows = await this.store.listCollectionsAudit({
      clinicId: debtor.clinicId,
      debtorRef: debtor.id,
      eventType: 'call_outcome',
    });
    return rows.map(toCallAttempt);
  }
}

/** Map an audit `call_outcome` row to a WS-1 `CallAttempt`. */
function toCallAttempt(row: CollectionsAuditRecord): CallAttempt {
  return {
    atMs: Date.parse(row.ts),
    hadConversation: row.refs?.hadConversation === true,
  };
}

/** Count attempts within the last `days` (for the audit `refs`, counts only). */
function attemptsInLastDays(attempts: CallAttempt[], nowMs: number, days: number): number {
  const cutoff = nowMs - days * DAY_MS;
  return attempts.filter((a) => Number.isFinite(a.atMs) && a.atMs > cutoff && a.atMs <= nowMs).length;
}
