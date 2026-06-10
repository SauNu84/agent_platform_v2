# ERD — Agent Platform canonical data model

- **Date:** 2026-06-06 (rev 2026-06-10, SAU-229 Slice-5 review) · **Author:** Enterprise Architect · **Issue:** SAU-175
- **Rev 2026-06-10 (SAU-229/SAU-230):** back-ported the Slice-5 identity + capability-RBAC model — concrete `app_user` (was the abstract `USER` entity), `auth_session`, `user_role`, `role_capability` ([ADR-007](../adr/ADR-007-rbac-roles-and-permissions.md)) — plus `owner_user_id` on `scenario`/`coach`/`course` and the now-FK'd `session.user_id`. Recorded the FORCE-RLS ownership backstop and the **required extension of RLS to the session projections** (`analysis`/`session_event`/`voice_usage`) in the Tenancy note.
- **Rev 2026-06-08:** back-ported the Slice-1 `voice_usage` metering table into the canonical model; documented `session.transcript` inline-vs-`transcript_uri` expand-contract; reconciled `session_event.type` vocabulary to the dot-notation used by the `RealtimeVoiceProvider` contract (ADR-003/005). No changes to compiled-table semantics.
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §3–§6
- **Governing ADRs:** [ADR-001](../adr/ADR-001-scenario-as-core-primitive.md) (Scenario primitive), [ADR-002](../adr/ADR-002-content-as-code.md) (MD source-of-truth → `content_source`), [ADR-004](../adr/ADR-004-coach-memory-model.md) (`coach_memory`, `consent_record`), [ADR-005](../adr/ADR-005-multimodal-tool-protocol.md) (`session_event`)

## Model notes

- **`scenario` is the atom.** `coach` and `course` are compositions over it; they do **not** duplicate persona/voice/rubric ([ADR-001](../adr/ADR-001-scenario-as-core-primitive.md)).
- **`course_scenario`** is the ordered join (Course → Scenarios); `position` gives the "Play All" sequence.
- **`session`** is the runtime artifact; **`analysis`** (Analyst) and **History** are projections over it. History is a **read-model/view** over `session`, not a base table (so it is shown below as a view, not an entity). Slice 1 stores the compiled transcript **inline** (`session.transcript` jsonb) since object storage isn't stood up yet; per expand-contract this moves to `transcript_uri` (object store) when the bucket lands — large transcripts must not stay in a hot table at scale.
- **`voice_usage`** is the per-session metering fact (one row per `session`, UNIQUE). Records metered `voice_minutes` plus the **measured** token breakdown (input/output/cached × text/audio) reported by the realtime vendor (`response.done.usage`), with `model` for rate attribution. Slice 1 only **records** usage; cap **enforcement** lands in Slice 2. This is the table the CFO unit-economics gate (SAU-196) and CRO margin verdict (SAU-198) read from.
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
    SESSION ||--o| VOICE_USAGE : "metered into"
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
        jsonb transcript "inline compiled transcript (Slice 1; moves to transcript_uri when object storage lands — expand-contract)"
        text transcript_uri "object store (archival; future)"
        text recording_uri "object store"
    }

    SESSION_EVENT {
        uuid id PK
        uuid session_id FK
        timestamptz ts
        text type "audio.output|user.transcript|agent.transcript|tool.call|tool.result|ui.effect|... (ADR-005; dot-notation per the RealtimeVoiceProvider contract)"
        jsonb payload
    }

    VOICE_USAGE {
        uuid id PK
        uuid session_id FK UK "one row per session"
        uuid user_id FK "nullable until user table lands"
        uuid scenario_id FK
        text vendor "realtime adapter (ADR-003)"
        text model "server-reported model id (rate attribution)"
        bigint duration_ms
        numeric voice_minutes "duration_ms / 60000 — metered minutes (cap enforcement: Slice 2)"
        bigint input_text_tokens
        bigint input_audio_tokens
        bigint cached_text_tokens
        bigint cached_audio_tokens
        bigint output_text_tokens
        bigint output_audio_tokens
        bigint total_tokens
        timestamptz created_at
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

## Identity & RBAC (Slice 5 — ADR-007)

The abstract `USER` entity above is realized by `app_user`. Identity is intentionally minimal (email + scrypt `password_hash`) behind an app-level auth seam — swappable for org SSO without a schema change. **Roles are config, not code:** `user_role` maps a user to a role; `role_capability` maps a role to atomic capabilities (the vocabulary is `CHECK`-fixed, the bundling is data). MVP ships 2 roles (`user`, `admin`); `operator` is seeded for B2B differentiation. The meaningful privacy boundary is the `view_identified_results` capability ([ADR-007](../adr/ADR-007-rbac-roles-and-permissions.md) §capabilities). `assignment` / `org_id` / `data_class` are deferred B2B seams, not built.

```mermaid
erDiagram
    APP_USER ||--o{ AUTH_SESSION : "authenticates via"
    APP_USER ||--o{ USER_ROLE : "assigned"
    USER_ROLE }o--|| ROLE_CAPABILITY : "resolved against (by role name)"
    APP_USER ||--o{ SCENARIO : "owns (owner_user_id)"
    APP_USER ||--o{ COACH : "owns (owner_user_id)"
    APP_USER ||--o{ COURSE : "owns (owner_user_id)"
    APP_USER ||--o{ SESSION : "runs (user_id FK)"

    APP_USER {
        uuid id PK
        text email UK "lower-cased by app"
        text password_hash "self-describing scrypt; never reversible"
        text display_name
        timestamptz created_at
        timestamptz updated_at
    }
    AUTH_SESSION {
        text token PK "opaque; httpOnly cookie value"
        uuid user_id FK
        timestamptz created_at
        timestamptz expires_at "server-enforced expiry/logout"
    }
    USER_ROLE {
        uuid user_id FK
        text role "PK(user_id, role); MVP = exactly one"
    }
    ROLE_CAPABILITY {
        text role "PK(role, capability)"
        text capability "CHECK-fixed vocabulary (7 atomic caps)"
    }
```

> **Ownership columns** (`scenario.owner_user_id`, `coach.owner_user_id`, `course.owner_user_id`) are **nullable** — `NULL` = platform/seeded content, world-readable. Added expand-contract; `session.user_id` gained its FK `NOT VALID` so pre-auth demo rows aren't retro-validated while new writes are enforced.

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

- **Hot indexes:** `session(user_id, started_at)` (History), `session(scenario_id)` (creator analytics), `session_event(session_id, ts)` (replay/Analyst), `analysis(session_id)` UNIQUE, `voice_usage(session_id)` UNIQUE + `voice_usage(user_id, created_at)` (per-user metering rollup) + `voice_usage(scenario_id)` (creator cost analytics), `scenario(metadata)` GIN (Library metadata filter), `coach_memory(coach_id, user_id, created_at)` + ANN index on `coach_memory.embedding`, `course_scenario(course_id, position)` PK.
- **FKs indexed** on every relationship column (SOUL red flag: missing FK indexes).
- **Tenancy ([ADR-004](../adr/ADR-004-coach-memory-model.md), CISO-mandated):** `coach_memory` access scoped by `(coach_id, user_id)` at the app layer, with **Postgres RLS mandated** as the defense-in-depth backstop — request-scoped `SET LOCAL app.user_id = <uuid>`; policy `USING (user_id = current_setting('app.user_id')::uuid)`; user-facing queries run under a non-bypass role. Waiving RLS requires CISO+CTO sign-off plus compensating controls (single data-access module, CI gate, prod cross-tenant canary).
- **Ownership RLS (Slice 5, [ADR-007](../adr/ADR-007-rbac-roles-and-permissions.md), SAU-229):** `scenario`/`coach`/`course`/`session` enforce FORCE RLS on `owner_user_id` (sessions on `user_id`), with public reads via `is_public`/`course.visibility`/null-owner. The app sets `app.user_id` + `app.is_admin` GUCs per transaction from a request-scoped actor (`SET LOCAL` via `set_config(...,true)`), mirroring the coach_memory pattern. A holder of `platform_admin` sets `app.is_admin='on'` (full bypass for DSAR/support).
- **RLS MUST extend to the session projections (`analysis`, `session_event`, `voice_usage`).** These carry *identified* per-user results (scores/report cards, raw transcript turns, metering) and are queried directly by `session_id`; `session`'s RLS does **not** cascade to them, so without their own policies a non-owner who supplies a session UUID reads another user's identified results — the exact `view_identified_results` boundary ADR-007 gates. Scope `analysis`/`voice_usage` by their denormalized `user_id`; scope `session_event` via an `EXISTS` against the owning `session`. (Tracked as the one required change on SAU-229.)
- **Consent provenance:** `consent_record` is append-only (revocation = new row); `consent_record(user_id, scope, created_at)` index for state reconstruction. Retained processing-duration + 6y, independent of memory erasure.
- **Audit logging:** memory write/retrieval/delete, consent change, export, DSAR action, and all staff access are logged append-only/tamper-evident, **no PII content**, ≥18-mo retention ([ADR-004](../adr/ADR-004-coach-memory-model.md) §DSAR + audit logging).
- **Migrations:** all schema changes to compiled tables follow expand-contract (the compiler is downstream; never break it mid-deploy).
- **Object storage:** transcripts/recordings referenced by URI; lifecycle/retention on the bucket aligns with [ADR-004](../adr/ADR-004-coach-memory-model.md) retention windows.
