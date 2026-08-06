/**
 * Collections compliance case study (SAU-336, WS-5) — the executable proof harness.
 *
 * The collections analogue of the clinic case study (SAU-287's case-study-run.ts):
 * a SINGLE runnable harness over synthetic debtors that proves the 10 server-side
 * guardrails hold end-to-end through the REAL stack —
 *
 *   • WS-1 (SAU-332) compliance engine   — `canDialNow` / `nextEligibleDial`
 *   • WS-2 (SAU-333) data + audit layer   — debtor store + HMAC hash-chained ledger
 *   • WS-3 (SAU-334) dialer + voice        — `CollectionsDialer`, disclosure, voicemail
 *   • WS-4 (SAU-335) outcome model + dash  — call attempts + `getCollectionsDashboard`
 *
 * Each of the 10 must-prove scenarios is a LOCKED pass/fail criterion. 0 compliance
 * violations is the bar — any violation is a HARD FAIL (non-zero exit). This is the
 * acceptance evidence for SAU-328 and the go/no-go dry-run artifact for the eventual
 * go-live gate (SAU-331).
 *
 * SCOPE: synthetic debtors only (SAU-328 / SAU-330 §8). Nothing here places a real call:
 * the dialer runs over an injected deterministic origination (never the network), and
 * the real outbound seam fails closed to the mock unless the SAU-331 go-live flag is set.
 *
 * Determinism: the time-sensitive gates are evaluated at FIXED, pre-verified instants
 * (a known weekday/in-window noon, an out-of-window hour, a Saturday, a federal holiday),
 * so the verdict never depends on when the harness is run.
 *
 * Run:  cd app && npx tsx scripts/collections-case-study-run.ts
 */
import { MemoryStore } from '@/db/memory-store';
import {
  canDialNow,
  nextEligibleDial,
  REG_F_MAX_ATTEMPTS,
  REG_F_WINDOW_DAYS,
  type CallAttempt,
  type DialBlockCode,
  type TenantCollectionsConfig,
} from '@/domain/collections-engine';
import { COLLECTIONS_REQUIRED_DISCLOSURE, screenVoicemailForDebtDetails } from '@/domain/collections-voice';
import { verifyCollectionsAuditIntegrity } from '@/domain/collections-audit';
import { CollectionsDialer } from '@/services/collections-dialer';
import {
  MockOutboundDialer,
  type OutboundCallStatus,
  type OutboundDialRequest,
} from '@/services/telephony/outbound-origination';
import { getCollectionsDashboard } from '@/services/collections-dashboard';
import type { Debtor } from '@/domain/collections';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Locked evaluation instants (verified: weekday/hour/holiday, debtor-local). ──
// All are 2026; the engine's holiday table covers 2026–2027.
const IN_WINDOW = Date.parse('2026-06-16T16:00:00Z'); // Tue, 12:00 ET (in 9–5 window)
const BEFORE_9 = Date.parse('2026-06-16T12:00:00Z'); // Tue, 08:00 ET (before open)
const AFTER_5 = Date.parse('2026-06-16T22:00:00Z'); // Tue, 18:00 ET (after close)
const WEEKEND = Date.parse('2026-06-20T16:00:00Z'); // Sat, 12:00 ET (non-working day)
const HOLIDAY = Date.parse('2026-06-19T16:00:00Z'); // Fri, 12:00 ET on Juneteenth (observed)

const LENDER_A = 'lender-a';
const LENDER_B = 'lender-b';

// ── Scorecard plumbing ─────────────────────────────────────────────────────────
interface Criterion {
  n: number;
  title: string;
  pass: boolean;
  evidence: string[];
}
const criteria: Criterion[] = [];
function record(n: number, title: string, checks: Array<[boolean, string]>): void {
  const evidence = checks.map(([ok, msg]) => `${ok ? '✓' : '✗'} ${msg}`);
  const pass = checks.every(([ok]) => ok);
  criteria.push({ n, title, pass, evidence });
}

// ── A deterministic, injectable origination backend the harness drives directly. ──
// Mirrors the real MockOutboundDialer but lets the harness pick connected/voicemail
// per scenario, so guardrails 5 (disclosure) and 8 (voicemail) can be proven without
// any network. `connectedCalls` captures the opening line played on every connect.
const originationState = { status: 'connected' as OutboundCallStatus };
const connectedCalls: Array<{ debtorRef: string; openingLine: string | null }> = [];
const origination = new MockOutboundDialer({
  simulate: (req: OutboundDialRequest) => {
    if (originationState.status === 'connected') {
      connectedCalls.push({ debtorRef: req.callId ?? '', openingLine: req.disclosure });
    }
    return originationState.status;
  },
});

// Mutable clock so one dialer instance can be evaluated at each locked instant.
const clock = { ms: IN_WINDOW };

async function main(): Promise<void> {
  const store = new MemoryStore();

  // ── Seed synthetic debtors (PII is fictitious; SAU-328 synthetic-only). ──
  const aCompliantNy = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-COMPLIANT-NY', name: 'Pat Sample', phone: '+12125550100',
    balanceCents: 42000, timezone: 'America/New_York', state: 'NY', consent: true,
  });
  const aCompliantCa = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-COMPLIANT-CA', name: 'Alex Synthetic', phone: '+14155550111',
    balanceCents: 31500, timezone: 'America/Los_Angeles', state: 'CA', consent: true,
  });
  const aVoicemail = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-VOICEMAIL', name: 'Jamie Fixture', phone: '+13125550122',
    balanceCents: 18000, timezone: 'America/Chicago', state: 'IL', consent: true,
  });
  const aOptOut = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-OPTOUT', name: 'Quinn Testcase', phone: '+12125550133',
    balanceCents: 9000, timezone: 'America/New_York', state: 'NY', consent: true, optedOut: true,
  });
  const aNoConsent = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-NOCONSENT', name: 'Rowan Mock', phone: '+12125550144',
    balanceCents: 12500, timezone: 'America/New_York', state: 'NY', consent: false,
  });
  const aUnknownTz = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-UNKNOWNTZ', name: 'Sky Placeholder', phone: '+19995550155',
    balanceCents: 7700, timezone: 'Not/AZone', state: null, consent: true,
  });
  const aDispute = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-DISPUTE', name: 'Drew Example', phone: '+12125550166',
    balanceCents: 25000, timezone: 'America/New_York', state: 'NY', consent: true, disputeOpen: true,
  });
  const aFreq = await store.upsertDebtor({
    clinicId: LENDER_A, externalRef: 'A-FREQUENCY', name: 'Casey Synthetic', phone: '+12125550177',
    balanceCents: 50000, timezone: 'America/New_York', state: 'NY', consent: true,
  });
  // Lender B — a second tenant, for the isolation proof.
  const bCompliant = await store.upsertDebtor({
    clinicId: LENDER_B, externalRef: 'B-COMPLIANT', name: 'Morgan Otherlender', phone: '+16175550188',
    balanceCents: 60000, timezone: 'America/New_York', state: 'MA', consent: true,
  });

  // SAU-521: an unconfigured tenant now fails closed (`licensing_unconfigured`), so this
  // case study must state which states its SYNTHETIC lenders are licensed in — otherwise
  // every criterion below would trivially "pass" by blocking everything, which proves
  // nothing. These are FIXTURE values for fake lenders over fake debtors; they are NOT a
  // claim about where we are licensed (that is counsel's, SAU-354 §9 Q3) and must never
  // be copied into a real tenant's policy.
  //
  // Both lenders are licensed in every state their own debtors are in, so the criteria
  // below still exercise the guardrail they are each named for rather than all collapsing
  // onto a licensing block. The one exception is the unknown-timezone debtor (state
  // `null`), which now also draws `state_not_licensed` — that is the CONFIGURED path's
  // default-deny doing its job, and it is a different code from the unconfigured-tenant
  // block, which is exactly the distinction SAU-521 preserves.
  const POLICY_A: TenantCollectionsConfig = { allowedStates: ['NY', 'CA', 'IL'] };
  const POLICY_B: TenantCollectionsConfig = { allowedStates: ['MA'] };

  // One dialer per tenant context (the store scopes reads/writes by clinic).
  const dialerA = new CollectionsDialer({ store, origination, config: POLICY_A, now: () => clock.ms, agencyName: 'Acme Recovery Services', callbackNumber: '+18005550100' });
  const dialerB = new CollectionsDialer({ store, origination, config: POLICY_B, now: () => clock.ms, agencyName: 'Acme Recovery Services', callbackNumber: '+18005550100' });

  // Helper: find the most recent audit row for a debtorRef (newest-first list).
  async function latestAudit(clinicId: string, debtorRef: string) {
    const rows = await store.listCollectionsAudit({ clinicId, debtorRef });
    return rows[0] ?? null;
  }

  // ── Criterion 1 — Out-of-window call is BLOCKED (before 9 / after 5 / weekend / holiday). ──
  {
    const checks: Array<[boolean, string]> = [];
    const cases: Array<[number, DialBlockCode, string]> = [
      [BEFORE_9, 'outside_calling_window', 'before 09:00 debtor-local'],
      [AFTER_5, 'outside_calling_window', 'after 17:00 debtor-local'],
      [WEEKEND, 'non_working_day', 'Saturday (non-working day)'],
      [HOLIDAY, 'holiday', 'federal holiday (Juneteenth, observed)'],
    ];
    for (const [at, code, label] of cases) {
      clock.ms = at;
      const r = await dialerA.attemptDial(aCompliantNy.id);
      const codes = r.reasons.map((x) => x.code);
      const audit = await latestAudit(LENDER_A, aCompliantNy.id);
      checks.push([
        r.decision === 'BLOCK' && !r.originated && codes.includes(code) && audit?.decision === 'BLOCK',
        `${label}: BLOCK (no origination), reason "${code}" present, decision logged`,
      ]);
    }
    record(1, 'Out-of-window call is blocked', checks);
  }

  // ── Criterion 3 — Opt-out suppresses the next dial (≤10 business days; we block on record). ──
  {
    clock.ms = IN_WINDOW; // in-window, so ONLY the opt-out gate can block.
    const r = await dialerA.attemptDial(aOptOut.id);
    const codes = r.reasons.map((x) => x.code);
    const audit = await latestAudit(LENDER_A, aOptOut.id);
    record(3, 'Opt-out suppresses the next dial', [
      [r.decision === 'BLOCK' && !r.originated, 'in-window opted-out debtor is BLOCKED, not originated'],
      [codes.includes('opted_out'), 'block reason is "opted_out"'],
      [audit?.decision === 'BLOCK' && (audit?.reason ?? '').includes('opted_out'), 'suppression decision is logged'],
    ]);
  }

  // ── Criterion 4 — No-consent debtor is never dialed. ──
  {
    clock.ms = IN_WINDOW;
    const r = await dialerA.attemptDial(aNoConsent.id);
    const codes = r.reasons.map((x) => x.code);
    record(4, 'No-consent debtor is never dialed', [
      [r.decision === 'BLOCK' && !r.originated, 'in-window no-consent debtor is BLOCKED, not originated'],
      [codes.includes('no_consent'), 'block reason is "no_consent"'],
    ]);
  }

  // ── Criterion 5 — Unknown TZ fails closed (never dialed). ──
  {
    clock.ms = IN_WINDOW;
    const r = await dialerA.attemptDial(aUnknownTz.id);
    const codes = r.reasons.map((x) => x.code);
    record(5, 'Unknown time zone fails closed', [
      [r.decision === 'BLOCK' && !r.originated, 'debtor with unresolvable TZ is BLOCKED, not originated'],
      [codes.includes('unknown_timezone'), 'block reason is "unknown_timezone" (fail-closed)'],
    ]);
  }

  // ── Criterion 8 — Open dispute pauses calling for that debtor. ──
  {
    clock.ms = IN_WINDOW;
    const r = await dialerA.attemptDial(aDispute.id);
    const codes = r.reasons.map((x) => x.code);
    record(8, 'Open dispute pauses calling', [
      [r.decision === 'BLOCK' && !r.originated, 'in-window disputing debtor is BLOCKED, not originated'],
      [codes.includes('dispute_open'), 'block reason is "dispute_open"'],
    ]);
  }

  // ── Criterion 6 — Disclosure present on EVERY connected synthetic call. ──
  // Connect three compliant debtors (two tenants) in-window; assert the server-injected
  // disclosure is the opening line on each, and matches the fixed mini-Miranda constant.
  {
    clock.ms = IN_WINDOW;
    originationState.status = 'connected';
    const before = connectedCalls.length;
    const rA = await dialerA.attemptDial(aCompliantCa.id);
    const rB = await dialerB.attemptDial(bCompliant.id);
    // aCompliantNy was only ever BLOCKED above (no call_outcome), so it is still dialable.
    const rA2 = await dialerA.attemptDial(aCompliantNy.id);
    const connectedNow = connectedCalls.slice(before);
    const allHaveDisclosure = connectedNow.length === 3 && connectedNow.every((c) => c.openingLine === COLLECTIONS_REQUIRED_DISCLOSURE);
    const resultsConnected = [rA, rB, rA2].every(
      (r) => r.originated && r.call?.status === 'connected' && r.disclosure === COLLECTIONS_REQUIRED_DISCLOSURE,
    );
    record(6, 'Disclosure present on every connected call', [
      [resultsConnected, 'all 3 connected calls carry the fixed disclosure (dialer result)'],
      [allHaveDisclosure, 'the disclosure was the FIRST utterance played on each connect (origination opening line)'],
      [COLLECTIONS_REQUIRED_DISCLOSURE.includes('attempt to collect a debt'), 'disclosure is the FDCPA §1692e(11) mini-Miranda'],
    ]);
  }

  // ── Criterion 7 — Limited-content voicemail: no debt details on voicemail. ──
  {
    clock.ms = IN_WINDOW;
    originationState.status = 'voicemail';
    const r = await dialerA.attemptDial(aVoicemail.id);
    originationState.status = 'connected'; // reset
    const script = r.voicemailScript ?? '';
    const screen = screenVoicemailForDebtDetails(script);
    record(7, 'Limited-content voicemail (no debt details)', [
      [r.originated && r.call?.status === 'voicemail' && script.length > 0, 'a voicemail script was left on the unanswered call'],
      [screen.ok, `voicemail contains NO prohibited debt details${screen.violations.length ? ` (found: ${screen.violations.join(', ')})` : ''}`],
      [!/\$|\bbalance\b|\bowe/i.test(script), 'no balance / amount / "you owe" language in the voicemail'],
    ]);
  }

  // ── Criterion 2 — Frequency cap enforced; Reg-F 7-in-7 ceiling cannot be exceeded. ──
  // Frequency gates consume the debtor's prior-attempt history (which the dialer derives
  // from the WS-2 ledger). To prove the ceilings deterministically, we evaluate the REAL
  // WS-1 engine at a fixed instant with explicit attempt histories — the same shape the
  // dialer feeds it — and also log the decisions to the ledger.
  {
    const evalDebtor = aFreq as Debtor; // full Debtor is assignable to DialEvaluableDebtor
    // (a) 2-week cadence: one attempt 3 days ago ⇒ within the 14-day minimum interval.
    const cadenceAttempts: CallAttempt[] = [{ atMs: IN_WINDOW - 3 * DAY_MS, hadConversation: false }];
    const cadence = canDialNow(evalDebtor, IN_WINDOW, { attempts: cadenceAttempts });
    const cadenceCodes = cadence.reasons.map((x) => x.code);

    // (b) Reg-F 7-in-7 HARD ceiling with an AGGRESSIVE config that tries to loosen
    // everything (zero cadence, 24h window): 7 attempts in the last 7 days must STILL block.
    const sevenAttempts: CallAttempt[] = Array.from({ length: REG_F_MAX_ATTEMPTS }, (_, i) => ({
      atMs: IN_WINDOW - (i + 1) * (DAY_MS / 2), // 7 attempts spread over the last ~3.5 days
      hadConversation: false,
    }));
    const aggressive = { cadenceDays: 0, windowOpenHour: 0, windowCloseHour: 24 };
    const ceiling = canDialNow(evalDebtor, IN_WINDOW, { attempts: sevenAttempts, config: aggressive });
    const ceilingCodes = ceiling.reasons.map((x) => x.code);

    // Log both decisions to the audit ledger (so they are part of the audited record).
    await store.recordCollectionsAudit({
      clinicId: LENDER_A, debtorRef: aFreq.id, eventType: 'dial_decision',
      decision: cadence.decision, reason: cadenceCodes.join(','), refs: { scenario: 'cadence', attempts: cadenceAttempts.length },
    });
    await store.recordCollectionsAudit({
      clinicId: LENDER_A, debtorRef: aFreq.id, eventType: 'dial_decision',
      decision: ceiling.decision, reason: ceilingCodes.join(','), refs: { scenario: 'reg_f_ceiling', attempts: sevenAttempts.length, aggressiveConfig: true },
    });

    record(2, 'Frequency cap enforced; Reg-F 7-in-7 cannot be exceeded', [
      [cadence.decision === 'BLOCK' && cadenceCodes.includes('cadence_not_elapsed'), '2-week cadence: a dial 3 days after the last attempt is BLOCKED (cadence_not_elapsed)'],
      [ceiling.decision === 'BLOCK' && ceilingCodes.includes('reg_f_7_in_7'), `Reg-F ceiling holds: ${REG_F_MAX_ATTEMPTS} attempts in ${REG_F_WINDOW_DAYS} days ⇒ BLOCK (reg_f_7_in_7)`],
      [ceiling.decision === 'BLOCK', 'the ceiling cannot be loosened by an aggressive tenant config (cadenceDays:0, 24h window)'],
    ]);
  }

  // ── Criterion 9 — Audit log is complete AND tamper-evident. ──
  {
    const rowsA = await store.listCollectionsAudit({ clinicId: LENDER_A });
    const rowsB = await store.listCollectionsAudit({ clinicId: LENDER_B });
    const all = [...rowsA, ...rowsB];

    // Completeness: every dial decision we made for Lender A produced a logged decision.
    // We attempted: 4 window blocks + opt-out + no-consent + unknown-tz + dispute + 2 connected
    // (CA, NY) + 1 voicemail + 2 frequency decisions = 13 dial_decision rows for Lender A
    // (connected/voicemail additionally append call_outcome rows).
    const dialDecisionsA = rowsA.filter((r) => r.eventType === 'dial_decision').length;
    const callOutcomesA = rowsA.filter((r) => r.eventType === 'call_outcome').length;

    // Tamper-evidence #1: the whole chain verifies (per-tenant), each tag over content + prev link.
    function chainVerifies(rows: typeof rowsA): boolean {
      const asc = [...rows].sort((a, b) => a.seq - b.seq);
      let prev = '';
      for (const r of asc) {
        if (r.prevIntegrity !== prev) return false; // chain linkage
        const ok = verifyCollectionsAuditIntegrity(
          { ts: r.ts, clinicId: r.clinicId, actorUserId: r.actorUserId, actorLabel: r.actorLabel, debtorRef: r.debtorRef, eventType: r.eventType, decision: r.decision, reason: r.reason, refs: r.refs },
          r.prevIntegrity, r.integrity,
        );
        if (!ok) return false;
        prev = r.integrity;
      }
      return true;
    }
    const chainsOk = chainVerifies(rowsA) && chainVerifies(rowsB);

    // Tamper-evidence #2: MUTATING a field is detected (the tag no longer verifies).
    const victim = [...rowsA].sort((a, b) => a.seq - b.seq)[0];
    const mutatedDetected = !verifyCollectionsAuditIntegrity(
      { ts: victim.ts, clinicId: victim.clinicId, actorUserId: victim.actorUserId, actorLabel: victim.actorLabel, debtorRef: victim.debtorRef, eventType: victim.eventType, decision: 'ALLOW', reason: 'forged', refs: victim.refs },
      victim.prevIntegrity, victim.integrity,
    );

    // Tamper-evidence #3: DELETING a row breaks the chain (next row's prevIntegrity no longer matches).
    const ascA = [...rowsA].sort((a, b) => a.seq - b.seq);
    const deletionDetected = ascA.length >= 3 && ascA[2].prevIntegrity !== ascA[0].integrity;

    record(9, 'Audit log complete and tamper-evident', [
      [dialDecisionsA >= 13, `every decision logged: ${dialDecisionsA} dial_decision + ${callOutcomesA} call_outcome rows for Lender A`],
      [chainsOk, 'the full HMAC hash-chain verifies for both tenants (content + chain linkage)'],
      [mutatedDetected, 'MUTATING any logged field is detected — the tamper-evidence tag fails to verify'],
      [deletionDetected, 'DELETING a row breaks the hash-chain (the next row no longer commits to its predecessor)'],
    ]);
    // Note: DB-enforced append-only (UPDATE/DELETE rejected even by a tenant admin) is
    // proven against real Postgres in tests/collections-data-rls.test.ts (REVOKE + trigger).
  }

  // ── Criterion 10 — Tenant isolation: Lender A cannot see Lender B's debtors/outcomes. ──
  {
    const dashA = await getCollectionsDashboard(store, LENDER_A, IN_WINDOW, POLICY_A);
    const dashB = await getCollectionsDashboard(store, LENDER_B, IN_WINDOW, POLICY_B);
    const aRefs = dashA.cadence.map((d) => d.externalRef);
    const bRefs = dashB.cadence.map((d) => d.externalRef);

    const aDebtors = await store.listDebtorsForClinic(LENDER_A);
    const aAudit = await store.listCollectionsAudit({ clinicId: LENDER_A });

    record(10, 'Tenant isolation (per-lender)', [
      [!aRefs.includes('B-COMPLIANT') && aRefs.includes('A-COMPLIANT-NY'), "Lender A's dashboard shows only Lender A debtors (B-COMPLIANT absent)"],
      [bRefs.includes('B-COMPLIANT') && !bRefs.some((r) => r.startsWith('A-')), "Lender B's dashboard shows only Lender B debtors (no A-* debtors)"],
      [aDebtors.every((d) => d.clinicId === LENDER_A), `Lender A's debtor list is tenant-scoped (${aDebtors.length} rows, all clinic=A)`],
      [aAudit.every((r) => r.clinicId === LENDER_A), `Lender A's audit ledger is tenant-scoped (${aAudit.length} rows, all clinic=A)`],
    ]);
    // Note: row-level RLS for the non-superuser app_rw role is enforced + proven against
    // real Postgres in tests/collections-data-rls.test.ts & collections-dashboard-rls.test.ts.
  }

  // ── Bonus liveness: nextEligibleDial gives the dashboard a real "when next" (not a guess). ──
  // (Not a locked criterion; sanity-checks WS-4 reuse of the WS-1 engine.)
  const optOutEligibility = nextEligibleDial(aOptOut as Debtor, IN_WINDOW);

  // ── Scorecard ──────────────────────────────────────────────────────────────
  criteria.sort((a, b) => a.n - b.n);
  const passed = criteria.filter((c) => c.pass).length;
  const violations = criteria.length - passed;

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(' SAU-336 WS-5 — Synthetic Collections Compliance Case Study');
  console.log(' Synthetic debtors only · real WS-1…WS-4 stack · no network');
  console.log('══════════════════════════════════════════════════════════════════\n');
  for (const c of criteria) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  #${c.n}  ${c.title}`);
    for (const e of c.evidence) console.log(`        ${e}`);
  }
  console.log('\n------------------------------------------------------------------');
  console.log(` Criteria passed : ${passed}/${criteria.length}`);
  console.log(` Compliance violations (hard-fail) : ${violations}`);
  console.log(` Opt-out debtor next-eligible : ${optOutEligibility.permanentBlock ? 'SUPPRESSED (state must change)' : optOutEligibility.nextMs}`);
  console.log('------------------------------------------------------------------\n');

  if (violations > 0 || passed !== criteria.length) {
    console.error(`✗ CASE STUDY FAILED — ${violations} criterion(s) did not pass. This is a hard fail.`);
    process.exit(1);
  }
  console.log('✓ CASE STUDY PASSED — all 10 guardrails proven, 0 compliance violations.');
}

main().catch((err) => {
  console.error('case study harness crashed:', err);
  process.exit(1);
});
