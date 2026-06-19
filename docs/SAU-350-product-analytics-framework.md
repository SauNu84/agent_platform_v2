# Product Analytics & Measurement Framework — Proviso (SAU-350, WS5)

**Owner:** Sr Data Full-Stack Engineer · **For:** CMO (UX / user-journey / CIP) · **Co-define:** [@Product Expert](agent://8526852b-b47b-4968-b097-5e35301b1275)
**Parent:** [SAU-345](/SAU/issues/SAU-345) (Product v2 commercialization) · **Inputs:** WS2 archetype PRDs ([SAU-347](/SAU/issues/SAU-347)) · **Date:** 2026-06-19
**Status:** v1 foundation shipped (code) — taxonomy/journeys ready for CMO + PE sign-off

> **One line:** a privacy-safe event stream + read-models that tell the CMO *where each archetype's journey converts, where it leaks, who activates, and who comes back* — so UX and the CIP run on data, not opinion. **No PHI, no PII — ever** (enforced in code + DB).

---

## 1. What shipped in this WS (the instrumentation foundation)

| Piece | Where | What it is |
|---|---|---|
| **Event taxonomy + journeys** | `app/src/domain/analytics-events.ts` | Closed set of canonical event names (`<archetype>.<noun>.<verb>`), per-archetype journey funnels, and the **PII guard** (`assertPiiFree`). |
| **Event store** | migration `0024_product_event.sql` + `recordProductEvent`/`queryProductEvents` | Append-only, **PII/PHI-free** `product_event` table. RLS-scoped, tamper-evident (UPDATE/DELETE blocked by trigger). |
| **Read-models (CMO)** | `app/src/services/product-analytics.ts` | `getFunnelReport`, `getActivationReport`, `getRetentionReport`, CSV export. Pure aggregation, no engine. |
| **`track()` write path** | `product-analytics.ts` | The only sanctioned emitter. Validates PII-free **before** persisting; `trackSafe` never breaks a product flow. |
| **Wired emitters (today's seams)** | `services/scenarios.ts`, `voice/session-service.ts` | `platform.agent.created` (on create) and `platform.agent.session.completed` (on every voice/client session). |
| **Tests** | `tests/product-analytics.test.ts` | 11 tests: PII guard, funnel, activation, retention, wired seam. Migration verified live (append-only + CHECK + RLS policy). |

**Verification:** `tsc` clean · 376 tests (365 pass / 0 fail / 11 skip) · migration 0024 applied to live Postgres (insert OK; bad archetype rejected; UPDATE/DELETE blocked; idempotent re-run).

---

## 2. Privacy posture (non-negotiable)

Product events answer "is the UX/journey working" — they are **neither** the privacy `audit_log` (ADR-004) **nor** the `phi_access_log` (SAU-275). They carry **no PHI and no PII**, enforced by **defence in depth**:

1. **Taxonomy** — events are a closed enum; no ad-hoc strings.
2. **`assertPiiFree` at the `track()` boundary** — rejects forbidden keys (`name`, `email`, `phone`, `dob`, `transcript`, `reason`, `patient`, `candidate`, …), non-scalar values, free text (>64 chars), and any value matching an **email** or **phone/account-number** shape. Fails **closed**.
3. **DB contract** — `props jsonb` holds **ids/enums/counts only**; the table grants INSERT/SELECT (no UPDATE/DELETE), append-only trigger, RLS by tenant.

`actor_id` / `tenant_id` are **internal UUIDs** (the same non-PII identifiers `audit_log` already stores) — needed for unique-count and retention cohorts. They are **not** names/emails/phones. This keeps the framework inside the existing compliance posture: the clinic archetype can be measured **without touching PHI**.

---

## 3. The journeys (from the WS2 PRDs)

Each archetype is an ordered funnel. **Cohort unit** = what a funnel/retention step counts (a *tenant* = a clinic/org; an *actor* = an end user/coordinator). `★` = activation step (first value); `$` = value step (job done).

### 3.1 Clinic Secretary — cohort: **tenant**  *(Stage-1 GTM lead)*
`clinic.demo.viewed` → `clinic.setup.started` → **★ `clinic.calendar.connected`** → `clinic.session.completed` → **$ `clinic.booking.completed`**

Supporting events: `clinic.confirmation.sent`, `clinic.session.escalated` (escalation precision — a PRD success metric).
**Why these:** mirror the PRD v1 success metrics — containment (session completed w/o escalation), booking accuracy/volume (value), escalation precision.

### 3.2 HRM Interview Panel — cohort: **actor** *(coordinator)*
`hrm.template.instantiated` → **★ `hrm.panel.configured`** → `hrm.session.completed` → **$ `hrm.assessment.generated`** → `hrm.assessment.rated`

Supporting: `hrm.specialist.activated` (a `set_active_subagent` transition — the **role-bleed** proxy the PRD calls for); `hrm.assessment.rated` carries `useful:bool` + `score:int` (the "would use again" metric).

### 3.3 Meeting Notetaker — cohort: **actor** *(PM / C-level)*
**★ `meeting.source.connected`** → `meeting.ingest.started` → **$ `meeting.synthesis.completed`** → `meeting.report.delivered` → `meeting.report.rated`

Supporting: `meeting.synthesis.completed` carries `decisions:int`, `action_items:int`; `meeting.report.rated` carries `trust_score:int`, `would_use:bool` (the PRD trust metric).

> Collections has its own compliance audit ledger (`collections_audit_log`, SAU-336); product-funnel events for it can be added to the taxonomy when it's productized as a 4th archetype (open decision in the positioning brief §8).

---

## 4. The metrics the CMO acts on

| Metric | Definition | Read-model |
|---|---|---|
| **Funnel conversion** | distinct cohort entities reaching each step; step-over-step + overall % | `getFunnelReport(archetype)` → `.steps[].stepConversion / overallConversion` |
| **Activation rate** | of entities that entered, % reaching the ★ step | `getActivationReport` → `.activationRate` |
| **Value-realization rate** | of entities that entered, % reaching the $ step | `getActivationReport` → `.valueRate` |
| **Week-over-week retention** | of entities active in week W, % active again in W+1 | `getRetentionReport` → `.weeks[].retentionRate` |
| **Per-template / per-tenant** | any of the above filtered by `tenantId` or windowed by `since`/`until` | `ReportWindow` arg on every read-model |

CSV export (`funnelToCsv`) so the CMO can drop a funnel into a deck without DB access.

**Leading "North-Star-feeders" per archetype** (for the CMO's dashboard):
- Clinic: **activation = % clinics that connect a calendar**; value = **bookings/clinic/week** (the GTM proof metric).
- HRM: activation = **% panels configured**; value = **assessments generated**; quality = **rated-useful %**.
- Meeting: activation = **% who connect a source**; value = **syntheses delivered**; quality = **trust score**.

---

## 5. The CIP (continuous improvement process) — how the CMO uses this

A weekly loop the framework is built to feed:

1. **Observe** — pull each archetype's funnel + retention for the trailing window.
2. **Find the leak** — the step with the worst `stepConversion` is the week's UX target.
3. **Hypothesize** (CMO + PE) — why does that step leak? (copy, friction, missing affordance.)
4. **Instrument the hypothesis** — if a sub-step isn't measured, add an event to the taxonomy (one-line PR) and ship the UX change.
5. **Measure** — compare next window's conversion at that step; keep or revert.

Cadence recommendation: **weekly funnel review**, **monthly cohort-retention review**. Pilot phase (design-partner, SAU-343): per-tenant funnels matter more than aggregate — use the `tenantId` filter.

---

## 6. Instrumentation map — what's wired vs. the named follow-ups

The archetype **value** events live on seams the archetype features don't fully exist on yet (inbound SMS, HRM template wrapper, the whole Meeting agent — all future WS work per the PRDs). They must be emitted **as each feature is built**, via `track()` / `trackSafe()` at the points below. This is the hand-off to WS3 and the archetype-build issues.

| Event | Emit at | Owner / when |
|---|---|---|
| `platform.agent.created` | ✅ **wired** — `scenarios.ts` create paths | shipped |
| `platform.agent.session.completed` | ✅ **wired** — `session-service.ts` (voice + client) | shipped |
| `clinic.demo.viewed` | use-case page view (`/use-cases/clinic-agent`) | WS3 UX |
| `clinic.setup.started` / `clinic.calendar.connected` | clinic config panel + OAuth callback (`services/clinic-config.ts`, calendar OAuth) | clinic packaging |
| `clinic.session.completed` (archetype-tagged) | `services/clinic-session.ts` completion | clinic packaging |
| `clinic.booking.completed` / `clinic.confirmation.sent` / `clinic.session.escalated` | clinic booking/notify/escalation services **(store + tenant ctx must be threaded — these executors are store-less + PHI-handling today)** | clinic packaging |
| `hrm.*` | HRM template wrapper + synthesis step (net-new per PRD) | HRM archetype build |
| `meeting.*` | Meeting ingest/synthesis/report (greenfield per PRD) | Meeting archetype build |

> **Engineering note for emitters:** never carry patient/candidate/meeting *content* — only enums (`outcome`, `surface`, `channel`), counts (`turns`, `decisions`), and booleans. `track()` will reject anything else and fail closed; use `trackSafe()` in hot product paths so analytics can never break a booking/call.

---

## 7. Open items for CMO + PE

1. **Sign-off on the taxonomy + journey definitions** (this doc §3) — are these the journeys the CMO wants to optimize?
2. **Activation thresholds** — confirm the ★ step per archetype (e.g. is clinic activation "calendar connected" or "first completed session"?).
3. **Collections as a 4th funnel** — add now or hold (positioning brief §8 open decision).
4. **A read surface** — do we want a CMO-facing analytics page/dashboard (reusing the existing `/analytics` pattern) in this WS, or is the service + CSV enough for v1? (Recommend: dashboard lands with WS3 commercial UX so it shares the shell.)
5. **Aggregation pushdown** — read-models aggregate in TS today (fine for pilot scale). Promote to SQL rollups when event volume warrants.

*Confidence legend: shipped/verified vs. follow-up is marked inline.*
