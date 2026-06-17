# SAU-330 — Collections Compliance Boundary (FDCPA / TCPA / Reg F) — go/no-go scoping

**Parent umbrella:** SAU-328 (AI Call Center Agent — compliant outbound collections). Blocks the umbrella build phase.
**Analogue:** the clinic's HIPAA program — SAU-268 (scoping) → SAU-272 (go-live gate). This is the **collections equivalent of SAU-268**: it scopes the regulatory boundary *before* any real debtor call. A later issue will own the **go-live gate** (the SAU-272 analogue) with the full sign-off checklist.
**Owner:** CISO. **Author posture:** security/compliance scoping. **NOT legal advice** — §9 lists the questions that require licensed counsel sign-off before any real outreach.
**Status:** Scoping complete. Synthetic-only POC is **in-bounds now**. The first real debtor call is **gated** on the §8 prerequisites and §9 counsel sign-off.

---

## 0. The one-paragraph boundary

Building and demoing the collections agent against **synthetic debtors** (a fabricated list, no PSTN dialing to real consumer numbers) is **in-bounds today** — same posture that let the clinic agent build Phase 0/1 before HIPAA sign-off. The regulatory trigger is the **first real outbound call to a real consumer about a real debt.** Everything in §1–§7 below is what that first real call must satisfy; §8 is the ranked go/no-go; §9 is the counsel-sign-off escalation. Debt-collection calling is heavily regulated and the penalties are per-call statutory damages plus state AG/CFPB exposure — so the rules are not advisory copy, they are **server-side guardrails the agent cannot override** (§6).

---

## 1. FDCPA (Fair Debt Collection Practices Act — 15 U.S.C. §1692 et seq.)

The FDCPA governs **how, when, and what** a collector may communicate. Key provisions the product touches:

| Provision | Rule | Product impact |
|---|---|---|
| §1692c(a)(1) | **Convenient time**: presumed **8 AM–9 PM debtor-local**. No calls at known-inconvenient times/places. | Our default **9 AM–5 PM working days is *stricter*** than the law — good. Must be **debtor-local** time, not server time (→ §6 time-zone resolution). |
| §1692d / §1692d(5) | **Harassment / abuse**: no repeated calls intended to annoy. | Frequency cap (§6) is the control; Reg F (§3) puts a hard number on it. |
| §1692e(11) | **Mini-Miranda**: in the initial communication, disclose it is *from a debt collector attempting to collect a debt and any information obtained will be used for that purpose*; in later calls, disclose the call is from a debt collector. | Required-disclosure injection (§6) — server-enforced into the script, **not** left to prompt wording. |
| §1692g | **Validation notice**: within 5 days of the initial communication, the consumer must get written notice of the amount, the creditor, and the 30-day right to dispute. | Build must **track** the validation-notice obligation and dispute window per debtor; a phone-only flow does not discharge it. |
| §1692b | **Third-party contact / location info** limits. | Out of scope for v1 (we only call the debtor's own number on the account); flag if "skip-tracing" is ever added. |

**The threshold question (escalate to counsel — §9):** the FDCPA primarily binds **third-party debt collectors**, not a creditor collecting *its own* debt in its own name. Our product is a **vendor placing calls on behalf of a lender** → that almost certainly makes us (or the configured outreach) a **third-party debt collector**, so assume the **full FDCPA applies**. Several states (e.g. CA Rosenthal Act) extend FDCPA-style duties to first-party creditors anyway. **Design to the strict (third-party) standard regardless** — it is the safe superset.

---

## 2. TCPA (Telephone Consumer Protection Act — 47 U.S.C. §227)

The TCPA governs the **technology** used to place the call. The relevant hook here is **artificial/prerecorded voice**, not the autodialer debate.

- **Artificial / prerecorded voice → prior express consent required** to call a cell phone. The **FCC Declaratory Ruling of Feb 8, 2024** confirms **AI-generated voice is "artificial"** under the TCPA. Our agent *is* an AI voice → **treat every call as an artificial-voice call requiring prior express consent.**
- **Consent standard:** debt-collection (informational, non-telemarketing) calls generally need **prior express consent**, which a consumer is treated as giving by **providing the phone number in connection with the debt** (FCC 2008 ACA ruling). Telemarketing would need prior express *written* consent — we are **not** telemarketing, but the build must not drift into upsell/marketing or the higher bar triggers.
- **Revocation:** the consumer may revoke consent by **any reasonable means**; the FCC's 2024 rules require honoring revocation **within a reasonable time, not to exceed 10 business days**. → opt-out suppression (§6) must propagate within that window.
- **ATDS is a side issue:** post-*Facebook v. Duguid* (2021) the autodialer definition is narrow, but the **artificial-voice provision is independent of ATDS** and still applies to us. Do not rely on "we're not an ATDS" as a defense.

**Net:** the build must have a **consent gate before dial** (§6) and must record **consent provenance** (where/when the number+consent came from — supplied and warranted by the client lender, §8).

---

## 3. Reg F (CFPB Debt Collection Rule — 12 CFR Part 1006, eff. Nov 30 2021)

Reg F operationalizes the FDCPA with hard numbers. Same third-party scope question as §1.

| Provision | Rule | Product impact |
|---|---|---|
| §1006.14(b)(2)(i) | **7-in-7**: no more than **7 call attempts within 7 consecutive days** per debt. | Hard ceiling on the frequency cap (§6). Our every-2-weeks default sits far inside it. |
| §1006.14(b)(2)(ii) | **7-day post-conversation cooldown**: no calling within **7 days** of a telephone conversation about the debt. | Cadence scheduler must record "spoke with debtor" and suppress for 7 days. |
| §1006.6(b) | **Inconvenient time/place**: before 8 AM / after 9 PM local presumed inconvenient. | Subsumed by our stricter 9–5 window (§6). |
| §1006.2(j), §1006.6(d)(2) | **Limited-content message**: a voicemail with only the allowed elements (consumer name, request for callback, business name not indicating debt collection, etc.) is **not** a "communication" and avoids third-party-disclosure risk. | Voicemail template (§6) must be the limited-content form — server-fixed, not free-text. |
| §1006.6(c) / §1006.6(e) | **Electronic opt-out** + disclosure requirements for email/SMS. | If/when SMS reminders are added, opt-out plumbing required; v1 voice-only narrows this. |

---

## 4. State overlays

State law frequently **adds** stricter caps and **licensing**:

- **Licensing:** many states require a **collection-agency license / bond** to collect (e.g. NY, MA, WA, and others). Operating unlicensed is itself a violation regardless of call conduct.
- **Stricter caps:** e.g. Massachusetts limits to **2 calls in 7 days** per debt — tighter than Reg F's 7-in-7; NYC has its own rules. The cadence engine must support **per-jurisdiction overrides**, not one global number.
- **Mini-Reg-F states / state AG enforcement:** several states have their own debt-collection acts (CA Rosenthal, TX Finance Code, etc.).

**POC stance:** synthetic debtors carry **no state nexus**, so the POC is unaffected. **Real rollout requires a per-state review**: enumerate licensed states, set the strictest applicable cap per debtor's state, and **hard-exclude out-of-bounds states** at the suppression layer. **Flag for go-live gate:** start with a small allow-list of states where the client lender is licensed; everything else is out-of-bounds until reviewed.

---

## 5. Debtor PII boundary (reuse the clinic envelope)

Debtor data — name, phone, account number, balance, due date, payment status — is **sensitive financial PII** even though it is **not PHI**. It carries **GLBA Safeguards Rule** obligations (financial data) and, where credit-report data is involved, **FCRA**. The good news: the clinic work already built the at-rest controls; **reuse them, don't reinvent.**

| Control | Reuse from | Application to debtor data |
|---|---|---|
| **Encryption at rest** | SAU-274 — AES-256-GCM `{_enc:"iv:ct:tag"}` envelope at the PgStore boundary | Encrypt debtor identity columns (name, phone, account, balance) the same way; non-identifying scheduling metadata can stay cleartext, same call we made for clinic slots. |
| **RLS actor-binding + multi-tenant isolation** | SAU-275 — `withActor` + per-tenant id, FORCE RLS | Each lender is a tenant; one lender must never read another's debtor list. Same pattern as multi-clinic (SAU-301). |
| **Append-only audit log** | SAU-275 — HMAC `phi_access_log` | A **collections audit log** (every dial attempt, outcome, consent state, opt-out event) on the same append-only/HMAC pattern. This log is *also* the compliance evidence trail. |
| **Retention / purge** | SAU-285 — scheduled crypto-shred / deletion | Define a debtor-data retention policy (hold while account active + statutory record-keeping window, then purge). Note: **retain the compliance audit trail** per record-keeping rules even after debtor PII is purged — same split we used for `phi_access_log` vs transcripts. |

No new cryptographic primitives are needed; this is configuration + a new tenant/table on proven seams.

---

## 6. The hard guardrails the build MUST enforce **server-side** (not prompt text)

This is the heart of the use case — "the rules ARE the product." Each must be a **system gate**, the same way the clinic's booking rules live in the tool, not the prompt. The agent must be **architecturally incapable** of violating them.

1. **Calling-window gate** — 9 AM–5 PM, working days only, evaluated in the **debtor's local time**. Out-of-window → never dialed.
2. **Frequency cap** — default **every-2-weeks** per debtor, with a hard **Reg-F 7-in-7 ceiling** and **7-day post-conversation cooldown** as un-overridable upper bounds, plus **per-state stricter caps** (§4).
3. **Do-not-call / opt-out suppression list** — checked **before every dial**; revocation honored within **10 business days** (§2). A suppressed number is never dialed.
4. **Consent gate before dial** — dial only if recorded **prior express consent** exists for that number (§2); missing/unknown consent → not dialed.
5. **Required-disclosure injection** — mini-Miranda (§1692e(11)) and identification are **server-injected** into the call script and **non-removable** by prompt edits.
6. **Time-zone resolution per debtor** — derive the debtor's local TZ (from account data; area code as fallback) so the window gate (#1) is correct. Unknown TZ → fail closed (don't dial).
7. **Holiday calendar** — calendar-aware scheduler suppresses weekends + holidays.
8. **Limited-content voicemail** — the only voicemail template allowed is the Reg-F limited-content form (§3).
9. **Validation-notice / dispute tracking** — track the §1692g obligation and dispute state per debtor; a dispute pauses calling.
10. **Compliance audit log** — every attempt, outcome, consent state, and opt-out event logged append-only (§5). This is both the control and the evidence.

**Design rule (carry over from clinic):** rules live in the **tool / scheduler / suppression layer**, never as instructions the model is *asked* to follow. The model proposes; the server disposes.

---

## 7. Vendor posture (the collections analogue of the BAA work, SAU-276)

There is **no "BAA"** here — BAA is a HIPAA construct. The equivalent is a **Data Processing Agreement (DPA) + use-case permissibility** check per vendor:

| Vendor | What we need | Notes |
|---|---|---|
| **Twilio** (telephony / outbound dialer) | DPA; **A2P 10DLC** registration; **STIR/SHAKEN** caller-ID authentication / branded caller ID; confirm Twilio's **AUP permits debt-collection** outbound. | Twilio carries its own carrier-level compliance for outbound calling; collections is a scrutinized category. Caller-ID authentication matters for answer rates *and* for not looking like a spoofer. |
| **OpenAI Realtime** (AI voice) | DPA + **zero-data-retention** (the ZDR posture we secured for the clinic under SAU-276); confirm debtor PII may be processed as audio/transcript input. | Same vendor, same ZDR ask — debtor PII instead of PHI. No BAA, but the data-handling bar is equivalent. |
| **Cloud host / managed Postgres** | Standard DPA + at-rest disk encryption (already in place from clinic deploy). | Reused. |

**Confirm before first real call:** each vendor's contract **permits collections use** and a DPA is executed. This is a contractual/procurement step (CEO/Legal chain), analogous to SAU-276.

---

## 8. Ranked go/no-go

### ✅ In-bounds for a **synthetic POC** right now
Everything the build needs to demonstrate, with **zero regulatory exposure**, provided:
- **Synthetic debtors only** — fabricated names/numbers; **no PSTN dialing to real consumer cell/landline numbers** (use the same synthetic-caller / owned-test-number approach proven in SAU-293).
- No real debt, no real consent records, no state nexus.
- Build & demo freely: compliance engine, cadence scheduler, calling-window/frequency/do-not-call gates, disclosure injection, dialer orchestration, voicemail, audit log, ops dashboard.

This is the **same posture** that let the clinic agent build Phase 0/1 before HIPAA sign-off.

### 🔴 Absolute prerequisites before the **first real debtor call** (go-live checklist — the SAU-272 analogue)
1. **Counsel sign-off** on the §1 threshold question (third- vs first-party collector) and which regs bind us — *blocking* (§9).
2. **Per-state licensing review** + a hard **state allow-list**; out-of-bounds states excluded at the suppression layer (§4).
3. **Consent provenance** — documented prior express consent per debtor, **warranted by the client lender** in contract (§2).
4. **AI-voice disclosure stance** confirmed with counsel against the **FCC Feb 2024 ruling** (§2).
5. **All 10 server-side guardrails** (§6) implemented and **tested** (the build phase's exit criteria).
6. **Debtor PII at rest**: encryption + RLS multi-tenant isolation + retention/purge + audit log live (§5; reuse SAU-274/275/285).
7. **Vendor DPAs + use-case permissibility** executed: Twilio (A2P/STIR-SHAKEN, collections-permitted) + OpenAI (DPA+ZDR) (§7).
8. **Validation-notice + dispute-handling** workflow operational (§1 §1692g).
9. **Do-not-call / opt-out suppression** operational and honored within **10 business days** (§2 §3).
10. **Compliance audit log + reporting** verified end-to-end (§5 §6).
11. **Client-lender contract**: who is collector-of-record, consent warranty, data-processing terms, and **indemnity** allocation.
12. **Board authorization** to make real calls (the explicit go signature, analogous to SAU-272's 3-sig sign-off).

**Until all 12 are green, the demo stays synthetic-debtor-only.** A future go-live gate issue (the SAU-272 analogue) will track these to closure with sign-off lines.

---

## 9. Legal counsel sign-off — required; questions to escalate

**Is counsel sign-off required? Yes** — items 1, 3, 4, and 11 in §8 turn on legal interpretation, not security controls, and the liability is statutory per-call. Per the execution contract we **escalate via chain rather than block indefinitely**: this scoping lands now and defines the boundary; the build proceeds on synthetic data; counsel answers are gated only at the **first real call**.

**Specific questions for counsel (route via CEO/Legal chain):**
1. **Collector status:** When our platform places calls on a lender's behalf, are we (and/or the lender's configured outreach) a **third-party debt collector** under the FDCPA and Reg F? Does the answer change if we white-label under the lender's name?
2. **AI-voice consent:** Given the FCC Feb 2024 ruling treating AI voice as "artificial," is **prior express consent** (number-provided-with-the-debt) sufficient for our informational reminder calls, or is anything more required? Any **AI-disclosure** obligation on-call?
3. **State scope:** Which states require a **collection-agency license** for this model, and which impose **stricter-than-Reg-F caps**? Recommend the initial **allow-list**.
4. **Contract allocation:** What consent **warranty** and **indemnity** language must the client-lender contract carry so consent-provenance risk sits with the party that holds the relationship?
5. **Validation notice:** Does our phone-first flow create any **§1692g** exposure if the written validation notice is the lender's responsibility, and how do we evidence the hand-off?

---

## 10. Disposition

- **Scoping deliverable: complete.** Boundary defined; synthetic POC in-bounds; first-real-call gated.
- **Build is unblocked on synthetic data** — the umbrella (SAU-328) build phase may proceed under the §8 "in-bounds" envelope; CPO can take a scoped build proposal to the board.
- **Counsel questions (§9) escalated** via the CEO/Legal chain — non-blocking for the synthetic build, blocking for the first real call.
- **Recommended next:** a dedicated **go-live gate issue** (the SAU-272 analogue) that drives the §8 12-item checklist + §9 counsel answers to a board-authorized real-call sign-off. *This does not commit us to the build; it defines what the build must satisfy.*
