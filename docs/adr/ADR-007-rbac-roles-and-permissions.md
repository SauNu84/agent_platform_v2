# ADR-007 — RBAC: roles & per-feature permissions

**Status:** Proposed (2026-06-10, CTO) — pending board approval on SAU-171
**Context:** Board question (SAU-171): "how many roles can we build, RBAC and permission access by application feature."

## Current state (verified)
- **No real auth/RBAC yet.** The app runs on a single `DEMO_USER_ID` stub (`app/src/services/current-user.ts`, marked *pre-auth*). The "role" chips in the library are a *content category* (PM/SWE/Sales), **not** a user role.
- **Primitives already present** that RBAC plugs into: `is_public` (scenario visibility), `share_link` (unlisted sharing), `consent_record` + `audit_log` + RLS on `coach_memory` (ADR-004/CISO), `user_entitlement` (credits/billing).
- The org already shipped an **auth/users system in Phase 2** (users, refresh_tokens, api_keys). **Decision: reuse it** — do not build a second identity system (boring-tech, ADR-002 spirit).

## Decision

### 1. How many roles — 3 core for MVP, 2 reserved for B2B
| Role | Who | Purpose |
|---|---|---|
| **Learner** (practitioner) | end user | Practice scenarios/courses/coaches; owns their sessions, history, analysis, memory. |
| **Creator** (author) | content builder | Author scenarios/coaches/courses (MD + AI-gen); publish/share; see analytics for *their own* content. |
| **Admin** | platform operator | Full management: all content, all users, roles, billing, feature flags. |
| *Org Manager* (reserved) | B2B tenant admin | Manage users + content + team analytics **within one org**. Build when B2B/multi-tenant audience is greenlit (board chose consumer-first). |
| *Reviewer* (reserved) | human publish-gate | Approve AI-generated content / review learner sessions. MVP: model as a **Creator capability**, not a separate role. |

Keep it **RBAC (role → capability), not ABAC**, at MVP. Roles are few and stable; complexity isn't justified yet.

### 2. Permission matrix by feature
Legend: ✅ full · ▢ own-only (ownership-scoped) · 🌐 public items only · ❌ none

| Feature / action | Learner | Creator | Admin |
|---|---|---|---|
| Browse library (Scenario/Course/Coach) | 🌐 | 🌐 + ▢ | ✅ |
| Run / Join a live session (metered) | ✅ | ✅ | ✅ |
| Author Scenario/Course/Coach (MD) | ❌ | ▢ | ✅ |
| Edit / publish / unpublish / delete content | ❌ | ▢ | ✅ |
| AI authoring (generate MD) + publish gate | ❌ | ▢ | ✅ |
| Coach memory — view / delete | ▢ (consent-gated) | ▢ | ✅ (DSAR/admin) |
| History — view sessions | ▢ | ▢ | ✅ |
| Analyst — own session analysis | ▢ | ▢ | ✅ |
| Analyst — Creator Analytics (aggregate) | ❌ | ▢ (own content) | ✅ |
| Billing / entitlement | ▢ (view/upgrade) | ▢ | ✅ (manage) |
| User & role management | ❌ | ❌ | ✅ |
| Feature flags / platform config | ❌ | ❌ | ✅ |

Most permissions are **ownership-scoped** (▢) — "own scenarios", "own sessions" — not just role-gated.

### 3. Enforcement architecture (two layers)
1. **Role/capability guard at the API/route layer** — checks the action type the role may perform (e.g. only Creator/Admin may `POST /scenarios`).
2. **Row-level ownership at the DB (Postgres RLS, FORCE)** — defense-in-depth for ▢ rows. Add `owner_user_id` to `scenario`, `coach`, `course`, `session`; public reads via existing `is_public`/`share_link`. Extends the RLS pattern already proven on `coach_memory`.

This split is the core idea: **role gates *what kind* of action; ownership (RLS) gates *which rows*.** Neither alone is sufficient.

### 4. Data model deltas
- `user_role` (user_id → role) — start single-role; the join table allows multi-role later without migration.
- `owner_user_id` on `scenario`/`coach`/`course`/`session` + FORCE RLS policies.
- **B2B seam (build later):** `org_id` (tenant) on users + content; tenant-scoped RLS; Org Manager role. Architect the column seam now; don't build until B2B is in scope.

## Consequences
- Replaces the `DEMO_USER_ID` stub with the Phase-2 auth identity — a real (bounded) build, best done as its own slice before/with monetization hardening.
- Clean, minimal model that covers the 5 core features and the creator/admin split without over-engineering.
- Reversible: more roles or ABAC can be layered later; the role→capability map is the seam.

## Build (on approval)
A dedicated **Slice 5 — AuthN + RBAC** issue: wire Phase-2 auth → add `user_role` + `owner_user_id` + RLS → role/capability guards on all routes → tests. CISO review on the ownership/RLS policies.
