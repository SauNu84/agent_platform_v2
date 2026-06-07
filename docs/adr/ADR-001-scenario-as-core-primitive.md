# ADR-001 — Scenario is the core primitive; Coach and Course are compositions

- **Status:** Accepted — **CTO-ratified 2026-06-06** (locks the core model; ratified on SAU-175 per the escalate-on-core-model rule)
- **Date:** 2026-06-06
- **Author:** Enterprise Architect
- **Deciders:** CTO (ratify), CPO (scope)
- **Parent:** SAU-171 (board-approved direction, 2026-06-06) · **Issue:** SAU-175
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §3, §4, §6
- **Supersedes / superseded by:** —

## Context

The brief presents five user-facing features — **Scenario, Course, Coach, Analyst, History**. The naive reading models each as an independent CRUD entity with its own persona, voice, rubric, and conversation logic.

Verified recon of the reference product (ToughTongue, live recon 2026-06-06) shows the opposite: the **only creatable agent object in their public API is `POST /scenarios`**. Scenario detail, Coach detail, and each in-course scenario all render the *identical* `Details / Sessions / Analytics` detail shell over an avatar + Overview + Your Instructions + Join action — direct visual proof they are the same object under different composition. Everything else is structure layered around the Scenario.

This is the single highest-leverage decision in the platform: get the primitive right and the rest is cheap; get it wrong and every feature re-implements persona/voice/rubric/conversation and we pay for the duplication forever.

## Decision

**Model the domain around one atom and a small number of compositions/projections over it:**

- **Scenario** — the atom. The complete agent definition: persona (`ai_instructions`), `rubric`, `voice`/language, `tools` (multimodal), visibility, metadata. The only hand-authored *agent* object.
- **Coach** — a **composition**: a Scenario (referenced or inlined) **+ persistent per-user memory + schedule/recurrence + Join**. Not a new agent type — a Scenario with memory and a cadence wrapped around it. (Memory model: see [ADR-004](ADR-004-coach-memory-model.md).)
- **Course** — a **composition**: an **ordered list of Scenario references** + optional Coach binding. Flat `course → scenarios` (l1 = course page, l2 = scenario detail). No module/lesson nesting until product demands it.
- **Session** — the runtime artifact of one conversation run (transcript + recording + events). Never hand-authored.
- **Analyst** — a **projection** over Sessions: rubric-scored evaluation + improvement plan (verified output shape in design §2) plus creator aggregates.
- **History** — a **projection** over Sessions: a per-user activity timeline. A read-model/view, **not** a base table.

The conversation engine, authoring pipeline, and analytics layer are each built **once** against Scenario and reused by every composition and projection.

## Consequences

**Positive**
- Each of the five features reduces to *one new table (or view) + reuse of the shared engine*. This is the explicit test of "good architecture here," and it passes (design §6).
- No duplicated persona/voice/rubric/conversation logic. Single place to evolve agent behavior.
- Course and Coach changes never touch the conversation engine — clean blast-radius isolation.

**Negative / trade-offs**
- Composition indirection: a Course references Scenarios rather than embedding them, so authoring tools must resolve references (mitigated by the content compiler, [ADR-002](ADR-002-content-as-code.md)).
- "Inline persona on a Coach" is a convenience that creates a second authoring path; we constrain it to *compile down to a Scenario row* so there is still exactly one runtime representation.
- Requires discipline: contributors will be tempted to add fields to Coach/Course that belong on Scenario. Schema review must enforce the boundary.

## Alternatives considered

1. **Three independent CRUD entities (Scenario, Coach, Course).** Rejected — triplicates persona/voice/rubric/engine logic; contradicts the verified single-object API; highest long-term cost.
2. **Generic "Agent" supertype with subtype tables.** Rejected as over-engineering for MVP — the composition model already gives reuse without a polymorphic-inheritance schema and its query complexity.

## Validation

Re-evaluate after Slice 3 (Course + Coach) ships: confirm no new conversation engine, authoring pipeline, or analytics path was required to build either composition. If either required one, this ADR failed and must be revisited.
