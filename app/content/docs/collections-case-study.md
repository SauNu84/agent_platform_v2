# Collections Compliance Case Study (SAU-336, WS-5)

**Synthetic debtors only.** Acceptance evidence for the AI Collections Agent (SAU-328) and the **go/no-go dry-run** for the eventual go-live gate (SAU-331). The collections analogue of the clinic case study (SAU-287).

## What this proves

A single runnable harness exercises the **real** collections stack end-to-end over synthetic debtors and proves all **10 server-side guardrails** hold:

- **WS-1** (SAU-332) compliance engine — `canDialNow` / `nextEligibleDial`
- **WS-2** (SAU-333) data + audit layer — debtor store + HMAC hash-chained ledger
- **WS-3** (SAU-334) dialer + voice — `CollectionsDialer`, disclosure, limited-content voicemail
- **WS-4** (SAU-335) outcome model + dashboard — call attempts + `getCollectionsDashboard`

**Bar: 0 compliance violations. Any violation is a hard fail (non-zero exit).**

## How to run

```bash
cd app && npm run case-study:collections
# (or: npx tsx scripts/collections-case-study-run.ts)
```

No infrastructure required: runs against the in-memory store and a deterministic, injected
origination backend — **nothing touches the network**. (The real outbound seam additionally
fails closed to the mock unless `COLLECTIONS_LIVE_DIAL_CONFIRMED` is set, gated on SAU-331.)

Time-sensitive gates are evaluated at **fixed, pre-verified instants** so the verdict never
depends on when the harness runs:

| Instant | UTC | Debtor-local (ET) | Used for |
|---|---|---|---|
| `IN_WINDOW` | 2026-06-16 16:00Z | Tue 12:00 | in-window control / connected calls |
| `BEFORE_9` | 2026-06-16 12:00Z | Tue 08:00 | before calling window |
| `AFTER_5` | 2026-06-16 22:00Z | Tue 18:00 | after calling window |
| `WEEKEND` | 2026-06-20 16:00Z | Sat 12:00 | non-working day |
| `HOLIDAY` | 2026-06-19 16:00Z | Fri 12:00 | federal holiday (Juneteenth, observed) |

## Result — latest run

```
 Criteria passed : 10/10
 Compliance violations (hard-fail) : 0
```

| # | Locked criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | **Out-of-window** call is blocked | PASS | BLOCK + no origination at before-9 / after-5 / Saturday / holiday; each reason code present; decision logged |
| 2 | **Frequency cap** + **Reg-F 7-in-7** ceiling | PASS | dial 3 days after last → `cadence_not_elapsed`; 7-in-7 → `reg_f_7_in_7` **even with an aggressive config** (cadenceDays:0, 24h window) |
| 3 | **Opt-out** suppresses next dial | PASS | in-window opted-out debtor BLOCKED, not originated; reason `opted_out`; logged |
| 4 | **No-consent** debtor never dialed | PASS | in-window no-consent debtor BLOCKED, not originated; reason `no_consent` |
| 5 | **Unknown TZ** fails closed | PASS | unresolvable TZ → BLOCK, not originated; reason `unknown_timezone` |
| 6 | **Disclosure** on every connected call | PASS | 3 connected calls (2 tenants); FDCPA §1692e(11) mini-Miranda is the first utterance on each |
| 7 | **Limited-content voicemail** | PASS | voicemail left on unanswered call; **no debt details** (no balance/amount/"you owe") |
| 8 | **Open dispute pauses** calling | PASS | in-window disputing debtor BLOCKED, not originated; reason `dispute_open` |
| 9 | **Audit log** complete + tamper-evident | PASS | 13 `dial_decision` + 3 `call_outcome` rows (Lender A); full HMAC chain verifies; mutation **and** deletion are detected |
| 10 | **Tenant isolation** (per-lender) | PASS | Lender A's dashboard / debtor list / ledger contain **only** Lender A rows; B's contain only B's |

## Method notes (honest scope)

- **Criteria 1, 3, 4, 5, 6, 7, 8** run through the real `CollectionsDialer` (which calls the
  WS-1 engine, writes to the WS-2 ledger, and injects the WS-3 scripts). A BLOCK decision is
  architecturally incapable of reaching origination.
- **Criterion 2** (frequency) is evaluated against the **real WS-1 engine** at a fixed instant
  with explicit attempt histories — the same `CallAttempt[]` shape the dialer derives from the
  ledger — because the gate is a function of prior-attempt timestamps. Both decisions are also
  written to the audit ledger. The dialer→engine wiring for frequency is unit-tested in
  `collections-engine.test.ts` / `collections-dialer.test.ts`.
- **Criterion 9** proves the tamper-evidence math (the HMAC hash-chain detects field mutation
  and row deletion) in-process. The **storage-level** append-only guarantee (UPDATE/DELETE
  rejected even by a tenant admin, via DB `REVOKE` + trigger) is proven against real Postgres
  in `tests/collections-data-rls.test.ts`.
- **Criterion 10** proves isolation through the product surfaces (dashboard / scoped lists).
  Row-level **RLS** for the non-superuser `app_rw` role is enforced + proven against real
  Postgres in `tests/collections-data-rls.test.ts` & `tests/collections-dashboard-rls.test.ts`.

## Gates

`tsc` clean · `eslint` clean · **365 tests, 354 pass / 0 fail / 11 skip** (skips are the
Postgres-gated RLS suites). Harness exits 0 with all 10 criteria passing.

## Relationship to the go-live gate (SAU-331)

This harness is the **dry-run** for SAU-331. It proves the guardrails hold on synthetic data;
the first **real** consumer call remains gated on SAU-331's 12-item checklist + Legal counsel
sign-off, and on `COLLECTIONS_LIVE_DIAL_CONFIRMED` being set out-of-band once that gate is green.
Re-running this harness against any future configuration change is the regression check for the
compliance posture.
