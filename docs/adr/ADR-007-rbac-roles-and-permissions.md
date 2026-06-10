# ADR-007 — RBAC: roles & per-feature permissions

**Status:** Proposed (rev 3, 2026-06-10, CTO) — pending board approval on SAU-171
**Context:** Board question (SAU-171): roles, RBAC, per-feature permissions.
**Rev history:** rev 1 = 3 roles · rev 2 = separated *target agents* from *user roles*, added Operator + assignment · **rev 3** = board asked "do Creator / Operator / Org Manager need to be separate roles?" → **no, not up front.** Model **capabilities**, bundle them into the *fewest roles that satisfy separation-of-duties*. MVP = **2 roles.**

## Two distinctions that drive the whole design
1. **Target agents ≠ user roles.** Mentor, Interviewer, Patient-intake … are **Scenarios/Coaches** (AI personas authored in Markdown) — *unlimited content*, never roles. Thousands of agents, zero new roles.
2. **Roles are bundles of capabilities, not bespoke types.** Don't mint a role per job title. Define atomic capabilities; a role is a named bundle. Split a role out **only when a real separation-of-duties requires it** (someone must do X but must *not* do Y). This keeps the set small and avoids over-engineering.

## Current state (verified)
No auth/RBAC built — single `DEMO_USER_ID` stub (pre-auth). Present primitives: `is_public`, `share_link`, `consent_record`+`audit_log`+RLS on `coach_memory`, `user_entitlement`. Org has **Phase-2 auth** → reuse.

## Decision

### Capabilities (atomic)
`practice` · `author_content` · `assign_to_users` · `view_identified_results` · `manage_org_members` · `manage_billing` · `platform_admin`

> The meaningful privacy boundary is **`view_identified_results`**: seeing a *named* end-user's session transcripts/scores is a far bigger grant than seeing your own data or anonymized aggregates. That capability — not a job title — is what actually needs gating.

### Roles = capability bundles. **MVP ships 2; B2B adds a 3rd.**
| Role | Capabilities | When |
|---|---|---|
| **User** | `practice` + `author_content` (own) + own data/analytics | **MVP** — covers both "I practice" and "I create/remix my own agents" (consumer model). |
| **Admin** | all | **MVP** — platform operation. |
| **Operator / Manager** | `author_content` + `assign_to_users` + `view_identified_results` (+ optionally `manage_org_members`, `manage_billing`) | **B2B** — when orgs/assignment arrive. |

### Do Creator / Operator / Org Manager need to be *separate* roles? — **No, not up front.**
They are **points on a capability spectrum**, not three things you need on day one:
- **Creator** = `author_content` only (sees *anonymized aggregate* analytics on own content).
- **Operator** = Creator **+ `assign_to_users` + `view_identified_results`** (sees *named* learners' results — the privacy step-up).
- **Org Manager** = **+ `manage_org_members` + `manage_billing`** (administers *people, seats, the tenant* — not content).

**Collapse rule:**
- **MVP (consumer-first, what we're building):** fold all authoring into **User**. No Operator, no Org Manager — there are no orgs or assignments yet. → **2 roles.**
- **B2B v1:** introduce **one** "Operator/Manager" role holding the program + org-admin capabilities. Don't pre-split.
- **Split Operator vs Org Manager only** when a real customer needs separation of duties — e.g. the person who *assigns training & reviews results* must NOT also *manage seats/billing* (large org, compliance). Until then, one role.
- **Split Creator vs Operator only** when an author must NOT see identified end-user data (e.g. a marketplace/3rd-party content author). Until then, `view_identified_results` is just a capability toggle.

Net: **2 roles now, 3 at B2B, 4 only if a customer's separation-of-duties forces it.** Roles are config over capabilities, so adding/splitting later is a data change, not a migration.

### Permission matrix by feature (MVP roles)
✅ full · ▢ own-only · ▣ assigned-scope (B2B Operator) · 🌐 public-only · ❌ none

| Feature / action | User | (B2B) Operator | Admin |
|---|---|---|---|
| Browse library | 🌐 + ▢ | 🌐 + ▢ | ✅ |
| Run / Join session (metered) | ✅ | ✅ | ✅ |
| Author agents (MD) + publish | ▢ | ▢ | ✅ |
| AI authoring + publish gate | ▢ | ▢ | ✅ |
| **Assign** agent to end-user / cohort | ❌ | ▣ | ✅ |
| View **identified** learner sessions/analytics | ❌ (own only) | ▣ (assigned, consent) | ✅ |
| Coach memory view/delete | ▢ (consent) | ▣ (consent) | ✅ (DSAR) |
| History / own analysis | ▢ | ▢/▣ | ✅ |
| User & role management, billing | ❌ | optional | ✅ |
| Platform config / feature flags | ❌ | ❌ | ✅ |

### Relationship model & enforcement (from rev 2, unchanged)
- **Self-practice** (MVP) vs **assigned/observed** (B2B): operator authors agent → `assign`s to end-user/cohort → reviews results. `assignment` (operator → target → assignee, consent-gated) is the only path to cross-user visibility.
- **Two layers:** role/capability guard (what action) + Postgres RLS on `owner_user_id`/`assignment` (which rows). Public via `is_public`/share-link.
- **PHI/HIPAA:** healthcare vertical gated by per-agent `data_class`; no PHI ship without CISO pass.

### Data model deltas
`user_role` (user→role) + a `role_capability` map (so roles are editable config) · `owner_user_id` + FORCE RLS · `assignment` (B2B) · `org_id` seam (B2B) · `data_class` (compliance).

## Consequences
- Answers the board: **don't separate Creator/Operator/Org Manager up front.** They're capability bundles; MVP needs **2 roles**; split only on real separation-of-duties. Avoids over-engineering while keeping the seam.
- Replaces demo-user stub with Phase-2 auth (Slice 5).

## Build (on approval) → "Slice 5 — AuthN + RBAC"
Reuse Phase-2 auth → `user_role` + `role_capability` + `owner_user_id` + RLS → capability guards on routes → tests → CISO review. `assignment`/`org_id` deferred to the B2B milestone.
