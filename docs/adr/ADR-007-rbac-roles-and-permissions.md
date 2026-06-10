# ADR-007 — RBAC: roles & per-feature permissions

**Status:** Proposed (rev 2, 2026-06-10, CTO) — pending board approval on SAU-171
**Context:** Board question (SAU-171): "how many roles, RBAC and permission access by feature." **Rev 2** incorporates the board's key correction: the platform will host *many target agents* (mentor-for-students, interview simulator, patient↔intake voice agent…) — so we must separate **user roles** from **agent personas**, and support the **operator-assigns-to-end-user** pattern those examples share.

## The distinction that drives everything (board's insight)
There are **two different things**, and only one of them is "roles":

1. **Target agents** (Mentor, Interviewer, Patient-intake, Doctor-appointment scheduler, …) = **Scenarios/Coaches**. These are the AI's *in-conversation persona*, authored as Markdown (`ai_instructions`). **They are unlimited** — anyone with the Creator/Operator capability can author infinitely many. They are *content*, **not** RBAC roles. The platform scales to thousands of target agents **without adding a single role.**
2. **User roles** (who may do what in the app) = a **small, fixed RBAC set**. This is what RBAC governs.

Conflating the two is the trap. The board's three examples are all *target agents* (Scenarios) used inside one relationship pattern → see §3.

## Current state (verified)
- **No auth/RBAC built yet** — single `DEMO_USER_ID` stub (`app/src/services/current-user.ts`, pre-auth). Library "role" chips are a *content category*, not a user role.
- Primitives present: `is_public`, `share_link`, `consent_record` + `audit_log` + RLS on `coach_memory` (ADR-004), `user_entitlement`. Org already shipped **Phase-2 auth (users/api_keys)** → **reuse it**.

## Decision

### 1. User roles — 4 core + 1 reserved
| Role | Who | Purpose |
|---|---|---|
| **Learner / End-user** | the practitioner | Practices agents (self-serve **or** assigned). Owns their sessions/history/analysis/memory. |
| **Creator** | content author | Authors target agents (Scenario/Coach/Course) as MD + AI-gen; publishes/shares; sees analytics for **their own** content. |
| **Operator** | program owner (recruiter / educator / clinic intake / mentor-program lead) | Creator **+ assigns** agents to specific end-users or cohorts **+ reviews those assigned sessions/analytics**. This is the generalization that covers all 3 board examples. Scoped to its program/org. |
| **Admin** | platform operator | Everything: all content, users, roles, billing, config. |
| *Org Manager* (reserved) | B2B tenant admin | Multi-team management within a tenant. Build when multi-tenant B2B is greenlit; `org_id` seam below. |

> **Why "Operator" is the answer to the board's question.** Mentor-for-students, interview simulator, and patient↔intake are not 3 new roles — they're 3 *Scenarios* (target agents) operated under the **same** pattern: someone sets up the agent, assigns it to end-users, and reviews results. One role (**Operator**) + the **assignment** concept (§3) covers all current and future verticals. New verticals = new *content*, not new roles.

### 2. Permission matrix by feature
✅ full · ▢ own-only · ▣ assigned-scope (operator sees end-users assigned to them) · 🌐 public-only · ❌ none

| Feature / action | Learner | Creator | Operator | Admin |
|---|---|---|---|---|
| Browse library | 🌐 | 🌐+▢ | 🌐+▢ | ✅ |
| Run / Join session (metered) | ✅ | ✅ | ✅ | ✅ |
| Author agents (Scenario/Coach/Course, MD) | ❌ | ▢ | ▢ | ✅ |
| Edit / publish / delete content | ❌ | ▢ | ▢ | ✅ |
| AI authoring + publish gate | ❌ | ▢ | ▢ | ✅ |
| **Assign** agent to end-user / cohort | ❌ | ❌ | ▣ | ✅ |
| Coach memory view/delete | ▢ (consent) | ▢ | ▣ (consent) | ✅ (DSAR) |
| History (sessions) | ▢ | ▢ | ▣ | ✅ |
| Analyst — session analysis | ▢ | ▢ | ▣ | ✅ |
| Analyst — aggregate analytics | ❌ | ▢ (own content) | ▣ (assigned cohort) | ✅ |
| Billing / entitlement | ▢ view | ▢ | ▢/▣ | ✅ |
| User & role management | ❌ | ❌ | ▣ (invite end-users) | ✅ |
| Feature flags / config | ❌ | ❌ | ❌ | ✅ |

### 3. The relationship model (this is the new part)
Two patterns the platform must support:
- **Self-practice** (MVP today): a Learner picks a public agent and practices solo. Sessions private to the Learner.
- **Assigned / observed** (the board's examples): an **Operator** authors/owns a target agent, **assigns** it to an end-user or cohort, the end-user practices, and the Operator **reviews** their sessions/analytics. Examples → all map cleanly:

  | Board example | Target agent (Scenario) | Operator | End-user (Learner) |
  |---|---|---|---|
  | Mentor to help a student find a scholarship | "Scholarship Mentor" coach | school / program lead | student |
  | Interview simulation | "Interviewer" scenario | recruiter / career center | candidate |
  | Patient ↔ voice agent to set up a doctor visit | "Intake scheduler" scenario | clinic | patient |

- New first-class concept: **`assignment`** (operator_user_id → target scenario/coach → assignee user or cohort). Visibility of a Learner's sessions/analytics to an Operator is **granted only via an assignment** (consent-gated), never global.

### 4. Enforcement (two layers, unchanged + assignment)
1. **Role/capability guard** at the API/route layer — *what kind* of action.
2. **Postgres RLS (FORCE)** on `owner_user_id` — *which rows*. Operator cross-user reads are allowed **only** through an `assignment` row (and consent). Extends the proven `coach_memory` RLS.

### 5. Data model deltas
- `user_role` (user_id → role; join table → multi-role later).
- `owner_user_id` on `scenario`/`coach`/`course`/`session` + FORCE RLS.
- `assignment` (operator_user_id, target_ref, assignee_user_id|cohort_id, consent, timestamps).
- **B2B seam (later):** `org_id` on users+content; tenant RLS; Org Manager.
- **Vertical compliance:** healthcare (the patient example) carries **PHI/HIPAA** weight — gate via a per-agent `data_class` (e.g. `phi`) that tightens retention/RLS/audit (ties to ADR-004 + CISO). Do **not** ship a healthcare/PHI vertical without a CISO compliance pass.

## Consequences
- Answers the board directly: **target agents are unlimited content (Scenarios), not roles**; **4 user roles** (+1 reserved) cover every vertical; the **Operator role + assignment** is what lets "many target agents for users" work.
- Replaces the demo-user stub with Phase-2 auth — a bounded build (Slice 5).
- Reversible/extensible: more roles or ABAC later; role→capability + assignment are the seams.

## Build (on approval) → "Slice 5 — AuthN + RBAC + assignment"
Wire Phase-2 auth → `user_role` + `owner_user_id` + `assignment` + RLS → route/capability guards → tests → CISO review of the ownership/assignment/PHI policies.
