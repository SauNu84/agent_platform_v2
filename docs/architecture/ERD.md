# ERD — Agent Platform canonical data model

- **Date:** 2026-06-06 · **Author:** Enterprise Architect · **Issue:** SAU-175
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §3–§6
- **Governing ADRs:** [ADR-001](../adr/ADR-001-scenario-as-core-primitive.md) (Scenario primitive), [ADR-002](../adr/ADR-002-content-as-code.md) (MD source-of-truth → `content_source`), [ADR-004](../adr/ADR-004-coach-memory-model.md) (`coach_memory`, `consent_record`), [ADR-005](../adr/ADR-005-multimodal-tool-protocol.md) (`session_event`)

## Model notes

- **`scenario` is the atom.** `coach` and `course` are compositions over it; they do **not** duplicate persona/voice/rubric ([ADR-001](../adr/ADR-001-scenario-as-core-primitive.md)).
- **`course_scenario`** is the ordered join (Course → Scenarios); `position` gives the "Play All" sequence.
- **`session`** is the runtime artifact; **`analysis`** (Analyst) and **History** are projections over it. History is a **read-model/view** over `session`, not a base table (so it is shown below as a view, not an entity).
- **`content_source`** tracks the MD source-of-truth + `content_hash`/git `revision` per compiled row ([ADR-002](../adr/ADR-002-content-as-code.md)); the DB row is downstream of the file.
- **`coach_memory`** is per-`(coach,user)`; stores derived summaries/facts, not raw transcripts ([ADR-004](../adr/ADR-004-coach-memory-model.md)). `embedding` = pgvector. **RLS mandated** (see Tenancy note).
- **`consent_record`** is the append-only record-of-consent for memory features ([ADR-004](../adr/ADR-004-coach-memory-model.md) §User controls); a revocation is a new row, never an update. Retained for *processing duration + 6 years*, outliving the memory it authorises.
- Recordings/large audio live in object storage; the row holds a `recording_uri`, not the blob. Object-store lifecycle mirrors the [ADR-004](../adr/ADR-004-coach-memory-model.md) retention windows (audio 30d/opt-in 90d; transcripts 90d).
- All FKs are indexed; hot query indexes called out in the notes after the diagram.

## Entity-relationship diagram (Mermaid)

```mermaid
erDiagram
    USER ||--o{ SESSION : runs
    USER ||--o{ COACH_MEMORY : "owns (per coach)"
    USER ||--o{ CONSENT_RECORD : "grants/revokes"

    SCENARIO ||--o{ COURSE_SCENARIO : "referenced by"
    SCENARIO ||--o{ SESSION : "instantiated as"
    SCENARIO |o--o| COACH : "composed into (ref or inline)"

    COURSE ||--o{ COURSE_SCENARIO : contains
    COURSE |o--o| COACH : "optionally bound to"
    COURSE ||--o{ SESSION : "context for"

    COACH ||--o{ COACH_MEMORY : accumulates
    COACH ||--o{ SESSION : "context for"

    SESSION ||--o{ SESSION_EVENT : emits
    SESSION ||--o| ANALYSIS : "scored into"
    SESSION |o--o| COACH_MEMORY : "summarized into"

    CONTENT_SOURCE |o--o| SCENARIO : compiles
    CONTENT_SOURCE |o--o| COACH : compiles
    CONTENT_SOURCE |o--o| COURSE : compiles

    SCENARIO {
        uuid id PK
        text slug UK
        text name
        text description
        text ai_instructions "persona / system prompt"
        jsonb rubric "[{topic,weight,...}] drives Analyst"
        boolean is_public
        text voice_name
        text language_code
        jsonb tools "enabled multimodal tools (ADR-005)"
        jsonb metadata "arbitrary k/v"
        timestamptz created_at
        timestamptz updated_at
    }

    COACH {
        uuid id PK
        text slug UK
        text name
        uuid scenario_id FK "null if inline persona"
        text inline_ai_instructions "compiles down to a scenario row"
        text memory_scope "per_user"
        text retention "persistent | window"
        jsonb schedule "cadence, channels"
        timestamptz created_at
        timestamptz updated_at
    }

    COURSE {
        uuid id PK
        text slug UK
        text name
        text visibility "public | private"
        uuid coach_id FK "optional binding"
        timestamptz created_at
        timestamptz updated_at
    }

    COURSE_SCENARIO {
        uuid course_id FK
        uuid scenario_id FK
        int position "ordered; Play All sequence"
    }

    SESSION {
        uuid id PK
        uuid user_id FK
        uuid scenario_id FK
        uuid coach_id FK "null unless coach-driven"
        uuid course_id FK "null unless in-course"
        text vendor "realtime adapter used (ADR-003)"
        text status "active | completed | failed"
        timestamptz started_at
        timestamptz ended_at
        text transcript_uri "object store"
        text recording_uri "object store"
    }

    SESSION_EVENT {
        uuid id PK
        uuid session_id FK
        timestamptz ts
        text type "audio|user_transcript|agent_transcript|tool.call|tool.result|ui.effect|... (ADR-005)"
        jsonb payload
    }

    ANALYSIS {
        uuid id PK
        uuid session_id FK UK "one analysis per session"
        numeric overall_score
        numeric final_score
        jsonb report_card "[{topic,score,note,weight}]"
        jsonb strengths
        jsonb weaknesses
        jsonb improvement "{improvement_areas, action_items, resources}"
        timestamptz created_at
    }

    COACH_MEMORY {
        uuid id PK
        uuid coach_id FK
        uuid user_id FK
        text kind "summary | fact | preference | goal"
        text content "derived, not raw transcript"
        vector embedding "pgvector, ANN index"
        uuid source_session_id FK
        numeric salience
        timestamptz created_at
        timestamptz expires_at "set at write time; drives purge job (ADR-004)"
    }

    CONSENT_RECORD {
        uuid id PK
        uuid user_id FK
        text scope "coach:<id> | global"
        text consent_type "persistent_memory | audio_retention"
        text action "granted | revoked"
        text policy_version
        text policy_text_hash "hash of exact wording shown"
        text locale
        text ui_surface
        inet source_ip
        text user_agent
        timestamptz created_at "append-only; event time"
    }

    CONTENT_SOURCE {
        uuid id PK
        text entity_type "scenario | coach | course"
        uuid entity_id "FK to compiled row"
        text repo_path
        text content_hash "drift detection vs file"
        text revision "git sha"
        timestamptz compiled_at
    }
```

## History (projection — view, not a table)

```sql
-- Per-user activity timeline; read-model over session (+ analysis for status/score).
-- Filterable by scenario, created_at, duration, status; actions: Analyze / Restore / Export CSV.
CREATE VIEW session_history AS
SELECT s.id, s.user_id, s.scenario_id, sc.name AS scenario_name,
       s.started_at, (s.ended_at - s.started_at) AS duration,
       s.status, (a.id IS NOT NULL) AS analyzed
FROM session s
JOIN scenario sc ON sc.id = s.scenario_id
LEFT JOIN analysis a ON a.session_id = s.id;
```

## Index & integrity notes

- **Hot indexes:** `session(user_id, started_at)` (History), `session(scenario_id)` (creator analytics), `session_event(session_id, ts)` (replay/Analyst), `analysis(session_id)` UNIQUE, `coach_memory(coach_id, user_id, created_at)` + ANN index on `coach_memory.embedding`, `course_scenario(course_id, position)` PK.
- **FKs indexed** on every relationship column (SOUL red flag: missing FK indexes).
- **Tenancy ([ADR-004](../adr/ADR-004-coach-memory-model.md), CISO-mandated):** `coach_memory` access scoped by `(coach_id, user_id)` at the app layer, with **Postgres RLS mandated** as the defense-in-depth backstop — request-scoped `SET LOCAL app.user_id = <uuid>`; policy `USING (user_id = current_setting('app.user_id')::uuid)`; user-facing queries run under a non-bypass role. Waiving RLS requires CISO+CTO sign-off plus compensating controls (single data-access module, CI gate, prod cross-tenant canary). RLS *should* extend to `session`/`session_event`/`analysis`.
- **Consent provenance:** `consent_record` is append-only (revocation = new row); `consent_record(user_id, scope, created_at)` index for state reconstruction. Retained processing-duration + 6y, independent of memory erasure.
- **Audit logging:** memory write/retrieval/delete, consent change, export, DSAR action, and all staff access are logged append-only/tamper-evident, **no PII content**, ≥18-mo retention ([ADR-004](../adr/ADR-004-coach-memory-model.md) §DSAR + audit logging).
- **Migrations:** all schema changes to compiled tables follow expand-contract (the compiler is downstream; never break it mid-deploy).
- **Object storage:** transcripts/recordings referenced by URI; lifecycle/retention on the bucket aligns with [ADR-004](../adr/ADR-004-coach-memory-model.md) retention windows.
