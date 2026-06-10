# Architecture Decision Records — Agent Platform

Formalized from the board-approved SAU-171 brandstorm (`../SAU-171-brandstorm-architecture.md` §8). Issue: SAU-175.

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-scenario-as-core-primitive.md) | Scenario is the core primitive; Coach/Course are compositions | **Accepted — CTO-ratified 2026-06-06** (core model locked) |
| [ADR-002](ADR-002-content-as-code.md) | Content-as-code: MD+frontmatter is source of truth; DB is a projection | **Accepted — CTO-ratified 2026-06-06** (core model locked) |
| [ADR-003](ADR-003-realtime-voice-build-vs-buy.md) | Realtime voice build-vs-buy + vendor selection | **Accepted** — **OpenAI Realtime** adopted for the Slice-0 voice MVP (board decision `333a08e1`, 2026-06-07; CTO sign-off recorded). Slice-0 spike measured live N=50; OpenAI misses the ≤800 ms TTFA bar (p95 1905 ms) — board override with post-launch latency/cost revisit triggers, recorded in the ADR |
| [ADR-004](ADR-004-coach-memory-model.md) | Coach memory model (storage/retrieval/retention/controls) | **Accepted** — CISO confirmation pass complete 2026-06-06 (SAU-178); all 7 MUST conditions verified in ADR-004 + ERD + ADR-003 privacy gate ([review](ADR-004-CISO-privacy-review.md)) |
| [ADR-005](ADR-005-multimodal-tool-protocol.md) | Multimodal tool protocol (stable in-session event contract) | **Accepted — CTO-ratified 2026-06-06** |
| [ADR-007](ADR-007-rbac-roles-and-permissions.md) | RBAC: roles (Learner/Creator/Admin + reserved Org-Manager/Reviewer) + per-feature permission matrix + ownership RLS enforcement | **Proposed 2026-06-10** — pending board approval on SAU-171 |
| [ADR-006](ADR-006-slice-integration-course-canonicalization.md) | Slice 1–4 integration: merge order + Course-domain canonicalization | **Accepted** — CTO-ratified in the SAU-203 thread; executed under SAU-210 (2026-06-08). One canonical Course domain (S3 persistence model) + one compiler (`course-compile.ts`), preserving S4's `validateCourseReferences` gate + input tolerances; publish-gate keeps `scenarios` min(1) required |

## Companion artifacts

- **ERD:** [`../architecture/ERD.md`](../architecture/ERD.md) — canonical data model (Mermaid).
- **C4 container diagram:** [`../architecture/C4-container.md`](../architecture/C4-container.md) — matches design §5 (Mermaid C4).
- **Slice-0 realtime voice spike:** [`../spikes/slice-0-realtime-voice/`](../spikes/slice-0-realtime-voice/) — interface contract, benchmark methodology, harness skeleton, results template. Feeds ADR-003.

## Escalations (per SAU-175)

- **CTO** — ✅ ratified ADR-001/002 (core model locked) and ADR-005 (2026-06-06); endorsed ADR-003 *buy* + ADR-004 architecture; ✅ **signed off the ADR-003 vendor selection (OpenAI Realtime) 2026-06-07** after the board ruling (`333a08e1`). **No open CTO items.**
- **CISO** — ✅ **confirmation pass complete 2026-06-06 (SAU-178): all 7 MUST conditions verified folded into ADR-004 + ERD + the ADR-003 privacy gate; ADR-004 privacy sign-off is final → Accepted.** Conditional sign-off was issued 2026-06-06 ([ADR-004 CISO Privacy Review](ADR-004-CISO-privacy-review.md), all 5 open items resolved) and EA folded all MUST conditions in the same day. **No open CISO items on ADR-004.** (ADR-003 vendor pick still carries the CISO privacy *gate* — enforced at Slice-0/selection, not an open ADR-004 item.)
