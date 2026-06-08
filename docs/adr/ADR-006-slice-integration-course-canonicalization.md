# ADR-006 — Slice 1–4 integration: merge order + Course-domain canonicalization

- **Status:** Accepted — CTO-ratified in the [SAU-203](/SAU/issues/SAU-203) thread; executed under [SAU-210](/SAU/issues/SAU-210)
- **Date:** 2026-06-08
- **Author:** Senior Data Full-Stack Engineer (Slice-2/4 author, integrator)
- **Deciders:** CTO (ratify), EA (architecture review on SAU-202)
- **Parent:** SAU-171 · **Issue:** [SAU-210](/SAU/issues/SAU-210)
- **Related:** [ADR-001](ADR-001-scenario-as-core-primitive.md), [ADR-002](ADR-002-content-as-code.md), [ADR-004](ADR-004-coach-memory-model.md)

## Context

The product was built as four vertical slices on separate lines:

- **S1** (SAU-200) — Scenario atom (MD compiler, CRUD, library, live voice).
- **S2** (SAU-201) — Analyst + History projections + credit/voice-minute meter.
- **S3** (SAU-202) — Course + Coach compositions (persistent coach memory + schedule).
- **S4** (SAU-203) — AI authoring (LLM emits validated Scenario/Course MD).

S1→S2→S4 were committed linearly on one branch; S3 was built in an isolated
worktree off the S1 reviewed HEAD. **S3 and S4 were authored by different dev
agents and each independently created a `Course` domain + compiler** — a real
`add/add` conflict neither could see alone. Integrating to `main` required a
defined merge order and one semantic reconciliation.

A merge dry-run surfaced **6 conflicts**: 5 mechanical/additive (the `Store`
interface + its two impls, the nav, the appended CSS) and **1 semantic**
(`domain/course.ts`). Migrations were already linear (`0001` S1 → `0002` S2 →
`0003` S3; S4 adds none), so no renumber was needed.

## Decision

### 1. Merge order
Land **S1 → S2 → S4 first** (already linear & clean), then **S3 last on top**.
S3 is the additive worktree and the canonical `Course` owner, so the one
reconciliation happens once, in the final merge.

### 2. The 5 mechanical conflicts → union
`store.ts`, `memory-store.ts`, `pg-store.ts` (disjoint method/field/type adds),
`layout.tsx` (nav), `globals.css` (appended styles): keep both sides.
- **Nav (`layout.tsx`)** was resolved to the *union of truth*, not a naive union:
  S3 branched before S2, so it had marked `/analytics` and `/history` as not-live.
  All five sections are live post-integration → `/library`, `/courses`, `/coaches`,
  `/analytics`, `/history` all `live: true`, using S3's actual (plural) route paths.

### 3. The 1 semantic conflict → **Slice 3's Course domain is canonical**
S3 owns Course *persistence* (`course` + `course_scenario` tables, `coachRef`
binding, services, 2-level UI, progress projection). S4 documented that it built
only a minimal content-artifact stand-in because "Course-row persistence is a
separate slice." That slice (S3) exists, so we unify on it.

**One `domain/course.ts`, one compiler:**
- Keep S3's `CompiledCourseRecord` (`coachRef` + `scenarioRefs`) and the
  `CourseRecord` DB projection. Field names `scenarioRefs` / `coachRef` are
  canonical.
- Canonical compiler = S3's **`compiler/course-compile.ts`** (persisting).
  **Retire** S4's `compiler/compile-course.ts`; the Slice-4 authoring pipeline is
  re-pointed at the canonical module.
- **Preserve from S4 (the Slice-4 safety property):**
  - `validateCourseReferences(record, knownSlugs)` — rejects dangling scenario
    refs at authoring time. Moved into `course-compile.ts`, operating on
    `scenarioRefs`.
  - Frontmatter **input tolerances** folded into the canonical schema: the
    `scenario_ids` alias and object-form members `{ slug, position }`.
  - `compileCourseContent` now wraps `normalizeCourseFrontmatter` so authoring
    failures (e.g. duplicate members) surface as `CourseCompileError`.

### 4. Publish-gate invariant (CTO refinement, ratified)
The canonical compile/publish schema keeps **at least one scenario required
(`min(1)`)** — a 0-scenario course is not a working course and MUST NOT clear the
gate (per the SAU-203 AC "nothing publishes without passing validation"). Only
S4's *input tolerances* fold into the canonical schema. S4's scenarios-optional
/ partial-draft tolerance stays **upstream in the authoring pipeline's
pre-publish/draft state**, never in compile/publish validation. This strengthens
the compiler-as-safety-gate thesis Slice-4 is built on rather than weakening it.

## Consequences

- Exactly **one** `Course` domain and **one** Course compiler on `main`.
- The Slice-4 AI-authoring gate (dangling-ref rejection, re-validate-on-publish,
  explicit approver) is intact; the Slice-3 coach binding + progress projection
  are intact. No work from any slice was lost.
- Reconciled suite is green: **51 tests** (the per-slice counts were cumulative
  per branch; the de-duplicated union is 51), `tsc` clean, lint clean, build
  clean — all four slices' routes present.
- **Follow-up (non-gating):** the durable `course` / `course_scenario` tables
  exist in S3's migration `0003`; the S4 authoring pipeline still treats the
  course manifest's ordered membership as the MD source of truth and persists
  member scenarios. Wiring the AI-authoring publish path to also upsert the
  durable course row (vs. returning the compiled course artifact) is a clean
  follow-up, not required for this integration.
