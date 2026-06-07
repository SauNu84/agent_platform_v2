# C4 Container Diagram — Agent Platform

- **Date:** 2026-06-06 · **Author:** Enterprise Architect · **Issue:** SAU-175
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §5, §7
- **Level:** C4 Level 2 (Containers). Matches the system architecture in design §5.
- **Governing ADRs:** [ADR-001](../adr/ADR-001-scenario-as-core-primitive.md), [ADR-002](../adr/ADR-002-content-as-code.md), [ADR-003](../adr/ADR-003-realtime-voice-build-vs-buy.md), [ADR-005](../adr/ADR-005-multimodal-tool-protocol.md)

## Container diagram (Mermaid C4)

```mermaid
C4Container
    title Container diagram — Agent Platform (Slices 0–4)

    Person(learner, "Learner", "Practices high-stakes conversations via voice/text")
    Person(author, "Author / Creator", "Writes Scenario/Coach/Course content as MD in git")
    Person(admin, "Operator", "Ops, on-call, analytics")

    System_Boundary(platform, "Agent Platform") {
        Container(web, "Web App + iframe Embed", "Next.js / React", "Library UIs, live session client (audio + ui.effect renderers), History/Analyst views. Embeds also exposed as iframe.")
        Container(api, "Core API / BFF", "Next.js / Node", "Scenarios, Coaches, Courses, Sessions, Analytics, Commerce. Owns the realtime adapter interface (ADR-003).")
        Container(compiler, "Content Compiler", "Node CLI in CI", "Validates MD+frontmatter against schema, upserts canonical rows, records content_hash/revision (ADR-002).")
        Container(realtime, "Realtime Conversation Service", "Adapter + vendor SDK", "startSession(scenario) -> events/sendAudio/registerTool/interrupt/stop. HARD BOUNDARY: vendor behind a stable interface (ADR-003). Hosts the multimodal tool protocol (ADR-005).")
        Container(worker, "Analysis Worker", "Node + queue consumer", "Async rubric scoring -> Analysis projection; session post-processing. Off the request path.")
        ContainerQueue(queue, "Job Queue", "queue", "Decouples analysis/post-processing from sessions.")
        ContainerDb(pg, "Postgres", "Postgres + pgvector", "Canonical rows (scenario/coach/course/session/analysis), coach_memory + embeddings (ADR-004), content_source.")
        ContainerDb(obj, "Object Store", "S3 / MinIO", "Recordings + transcripts (referenced by URI).")
    }

    System_Ext(vendor, "Realtime Voice Vendor", "OpenAI Realtime / Gemini Live / LiveKit / Pipecat — chosen via Slice-0 (ADR-003). Swappable behind the adapter.")
    System_Ext(claude, "AI Content Generation", "Claude — emits validated Course/Scenario MD (Slice 4); review-gated before compile.")
    System_Ext(stripe, "Billing / Credits", "Stripe — reused Phase-2 subscriptions + usage metering.")
    System_Ext(git, "Content Repo", "git — MD source-of-truth for all content (ADR-002).")

    Rel(learner, web, "Talks / interacts", "WebRTC + HTTPS")
    Rel(author, git, "Authors MD via PR")
    Rel(admin, web, "Views analytics / ops")

    Rel(git, compiler, "Triggers on merge", "CI")
    Rel(compiler, pg, "Upserts canonical rows")
    Rel(claude, git, "Proposes MD (PR)", "review-gated")

    Rel(web, api, "API calls", "HTTPS/JSON")
    Rel(web, realtime, "Live audio + ui.effect events", "WebRTC / WS")
    Rel(api, pg, "Reads/writes canonical + memory")
    Rel(api, obj, "Stores/reads transcripts + recordings")
    Rel(api, realtime, "startSession(scenario)", "internal interface")
    Rel(realtime, vendor, "STT->LLM(+tools)->TTS, vision/tone", "vendor protocol")
    Rel(realtime, pg, "Persists session_event stream (ADR-005)")
    Rel(api, queue, "Enqueues analysis jobs")
    Rel(queue, worker, "Delivers jobs")
    Rel(worker, pg, "Writes Analysis projection")
    Rel(worker, obj, "Reads transcripts")
    Rel(api, stripe, "Credits / subscriptions")
```

## Reading guide

- **The component that decides the project** is the *Realtime Conversation Service* (design §5). It is drawn as a distinct container precisely so the **external vendor is swappable** behind the `startSession` interface ([ADR-003](../adr/ADR-003-realtime-voice-build-vs-buy.md)). Slice-0 measures vendors against that boundary.
- **Two deliberately novel surfaces** (design §7): the *Content Compiler* and the *Realtime adapter*. Everything else is boring/reused (Next.js, Postgres, Stripe, queue+worker, object store).
- **Authoring is content-as-code** ([ADR-002](../adr/ADR-002-content-as-code.md)): humans and Claude both produce MD → PR → compiler → canonical rows. No path writes canonical content directly to Postgres at runtime.
- **Analysis is async** (off the request path) — sessions stay fast; scoring happens on the worker.
- **History/Analyst are projections** over `session` (ERD) served by the Core API; not separate stores.

## SLI/SLO starting points (to formalize before Slice 0 ships — SOUL: no system ships without SLIs)

| Container | SLI | Provisional SLO |
|---|---|---|
| Realtime Conversation Service | Voice time-to-first-audio (p95) | ≤ 800 ms (validated by Slice-0; [ADR-003](../adr/ADR-003-realtime-voice-build-vs-buy.md) bar) |
| Realtime Conversation Service | Session establishment success rate | ≥ 99% |
| Core API / BFF | Request availability / p95 latency | ≥ 99.9% / ≤ 300 ms |
| Analysis Worker | Job success rate; analysis freshness (p95) | ≥ 99% ; ≤ 2 min after session end |
| Content Compiler | Compile success on valid MD; bad-MD rejection | 100% / 100% (never reaches DB) |

These SLIs feed the observability work ([HEARTBEAT] golden-signal coverage) and must be instrumented and alerting before Slice-0 goes beyond the bench.
