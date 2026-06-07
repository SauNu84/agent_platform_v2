# ADR-002 — Content-as-code: Markdown + YAML frontmatter is the source of truth; the DB row is a projection

- **Status:** Accepted — **CTO-ratified 2026-06-06** (locks the core model; ratified on SAU-175 per the escalate-on-core-model rule)
- **Date:** 2026-06-06
- **Author:** Enterprise Architect
- **Deciders:** CTO (ratify), CPO (scope)
- **Parent:** SAU-171 · **Issue:** SAU-175
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §4
- **Related:** [ADR-001](ADR-001-scenario-as-core-primitive.md), [ADR-005](ADR-005-multimodal-tool-protocol.md)

## Context

The brief repeats three times: "**It can be set up by MD file.**" The board approved this stance. This is an architectural decision, not a UI detail: it dictates where the source of truth lives, how content is reviewed, how AI generates content, and how the DB is populated.

Two readings are possible:
1. MD is an *import format* — a one-time loader; the DB is then the source of truth and is edited directly.
2. MD is the *source of truth* — the DB is a compiled projection; you never hand-edit DB rows.

The product wants courses "created by AI." An LLM writing validated Markdown that passes a schema gate is far safer than an LLM issuing writes directly against the production DB.

## Decision

**Adopt content-as-code (reading #2).** Every Scenario / Coach / Course is authored as a **Markdown file with YAML frontmatter**, stored in **git**. A **content compiler** validates each file against a published schema and **upserts** the canonical DB record. The MD file is authoritative; the DB row is a projection keyed by a stable `id`/slug and tagged with the source `content_hash` and git revision.

- **Authoring flow:** edit MD → PR → schema validation in CI → review/approve → merge → compiler upserts canonical rows. Content changes are versioned, diff-able, peer-reviewed, and revertable like code.
- **AI authoring flow:** LLM emits MD → schema validation gate → human/coach review gate → merge (same pipeline). The model never writes to the DB directly. (Slice 4.)
- **Runtime reads** hit the canonical DB rows (fast, indexed), never the filesystem.
- **Drift control:** the compiler records `content_hash` + git `revision` per row (`ContentSource` in the ERD). A row whose `content_hash` ≠ current file hash is flagged stale; direct DB edits to compiled fields are rejected/overwritten on next compile (the DB is downstream).

Frontmatter schemas (canonical examples in design §4): Scenario → `name, persona, rubric[], voice, tools[], visibility, metadata`; Coach → `kind: coach, scenario|persona, memory, schedule`; Course → `kind: course, visibility, coach?, scenarios[] (ordered)`.

## Consequences

**Positive**
- Versioned, reviewable, diff-able, revertable content; full audit trail in git.
- AI-generated content passes through the *same* validation + review gate as human content — a single quality boundary ([risk: AI-generated course quality], design §9).
- Disaster recovery for content is `git checkout` + recompile — the DB is reconstructable from source.
- The novel surface area is deliberately confined to the compiler + the realtime adapter ([ADR-003](ADR-003-realtime-voice-build-vs-buy.md)).

**Negative / trade-offs**
- Two representations (file + row) must be kept consistent — the compiler and `content_hash` reconciliation are load-bearing and need tests.
- No live in-app WYSIWYG editing of canonical fields at MVP (edits go through git/PR). If product later wants in-app editing, we either generate MD from the editor (still source-of-truth-in-git) or revisit this ADR. Flagged as a known constraint, not a blocker.
- Compiler is a single point of failure for content publishing — must be idempotent, transactional per file, and safe to re-run. Covered by the migration/expand-contract discipline for any schema change to compiled tables.

## Alternatives considered

1. **MD as import-only, DB as source of truth.** Rejected — loses versioning/review/AI-safety benefits the board explicitly wants; reintroduces "LLM writes to prod DB" risk.
2. **Headless CMS (Sanity/Contentful) as source of truth.** Rejected — new vendor + new datastore, no git-native diff/review, weaker AI-generates-validated-artifact story, and contradicts the "default to boring, reuse what we run" stance (design §7).

## Validation

After Slice 1: confirm a Scenario can be created, edited, and reverted entirely through git→compiler with zero direct DB edits, and that a deliberately malformed frontmatter file is rejected at the CI gate (never reaches the DB).
