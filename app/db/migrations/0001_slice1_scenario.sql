-- ============================================================================
-- Migration 0001 — Slice 1: the Scenario atom
-- ----------------------------------------------------------------------------
-- Aligns to the EA ERD (docs/architecture/ERD.md, SAU-175). Slice 1 stands up
-- only the tables the Scenario atom needs end-to-end:
--   scenario        — the core primitive (ADR-001)
--   content_source  — MD source-of-truth + drift detection (ADR-002)
--   session         — runtime artifact of a live voice run
--   session_event   — ordered event stream emitted during a session (ADR-005)
--   voice_usage      — metered voice minutes + measured token usage per session
--
-- Slice boundaries (deliberately deferred to later slices, per ERD/build plan):
--   * coach / course / course_scenario  -> Slice 3 (compositions)
--   * analysis (Analyst) + session_history view -> Slice 2 (projections)
--   * coach_memory / consent_record + RLS -> Slice 3/4 (memory + CISO controls)
--   * "user" table + auth -> not in this slice; session.user_id is a nullable
--     uuid WITHOUT an FK yet, so we record who ran a session without prematurely
--     pulling in the full identity model. Expand-contract: a later migration adds
--     the FK once the user table lands.
--
-- Migrations to compiled tables follow expand-contract — the MD compiler is
-- downstream and must never be broken mid-deploy (ADR-002 / ERD migration note).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── scenario ── the atom (ADR-001) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scenario (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text NOT NULL UNIQUE,
    name            text NOT NULL,
    description     text,
    ai_instructions text NOT NULL,                    -- persona / system prompt
    rubric          jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{topic,weight,...}] drives Analyst
    is_public       boolean NOT NULL DEFAULT false,
    voice_name      text NOT NULL DEFAULT 'alloy',
    language_code   text NOT NULL DEFAULT 'en-US',
    tools           jsonb NOT NULL DEFAULT '[]'::jsonb, -- enabled multimodal tools (ADR-005)
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb, -- arbitrary k/v (filterable in Library)
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- GIN index supports the Library's "filter by metadata" query.
CREATE INDEX IF NOT EXISTS scenario_metadata_gin ON scenario USING gin (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS scenario_is_public_idx ON scenario (is_public);

-- ── content_source ── MD source-of-truth + drift detection (ADR-002) ────────
CREATE TABLE IF NOT EXISTS content_source (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type  text NOT NULL CHECK (entity_type IN ('scenario', 'coach', 'course')),
    entity_id    uuid NOT NULL,        -- FK to the compiled row (scenario.id for Slice 1)
    repo_path    text NOT NULL,        -- e.g. content/scenarios/sales-objection.md
    content_hash text NOT NULL,        -- sha256 of the source file; drift detection vs file
    revision     text,                 -- git sha at compile time (nullable if not in git)
    compiled_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS content_source_entity_idx ON content_source (entity_type, entity_id);

-- ── session ── runtime artifact ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid,                              -- nullable; FK added when user table lands
    scenario_id    uuid NOT NULL REFERENCES scenario (id) ON DELETE CASCADE,
    coach_id       uuid,                              -- null unless coach-driven (Slice 3)
    course_id      uuid,                              -- null unless in-course (Slice 3)
    vendor         text NOT NULL,                     -- realtime adapter used (ADR-003)
    status         text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'completed', 'failed')),
    started_at     timestamptz NOT NULL DEFAULT now(),
    ended_at       timestamptz,
    transcript     jsonb,                             -- compiled transcript (turns + toolCalls)
    transcript_uri text,                              -- object store (large/archival; future)
    recording_uri  text                               -- object store
);

-- Hot indexes per ERD: History (user_id, started_at) and creator analytics (scenario_id).
CREATE INDEX IF NOT EXISTS session_user_started_idx ON session (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS session_scenario_idx ON session (scenario_id);

-- ── session_event ── ordered event stream (ADR-005) ─────────────────────────
CREATE TABLE IF NOT EXISTS session_event (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
    ts         timestamptz NOT NULL DEFAULT now(),
    type       text NOT NULL,   -- audio|user.transcript|agent.transcript|tool.call|tool.result|ui.effect|...
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS session_event_session_ts_idx ON session_event (session_id, ts);

-- ── voice_usage ── metered voice minutes + measured tokens per session ──────
-- Slice 1 requirement: "Voice minutes must be metered ... record usage now."
-- Cap ENFORCEMENT lands in Slice 2; this slice only RECORDS usage so the
-- enforcement layer has real data to act on. One row per session.
CREATE TABLE IF NOT EXISTS voice_usage (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          uuid NOT NULL UNIQUE REFERENCES session (id) ON DELETE CASCADE,
    user_id             uuid,
    scenario_id         uuid NOT NULL REFERENCES scenario (id) ON DELETE CASCADE,
    vendor              text NOT NULL,
    model               text,                  -- server-reported model (rate attribution)
    duration_ms         bigint NOT NULL DEFAULT 0,
    voice_minutes       numeric(12,4) NOT NULL DEFAULT 0,  -- duration_ms / 60000
    input_text_tokens   bigint NOT NULL DEFAULT 0,
    input_audio_tokens  bigint NOT NULL DEFAULT 0,
    cached_text_tokens  bigint NOT NULL DEFAULT 0,
    cached_audio_tokens bigint NOT NULL DEFAULT 0,
    output_text_tokens  bigint NOT NULL DEFAULT 0,
    output_audio_tokens bigint NOT NULL DEFAULT 0,
    total_tokens        bigint NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_usage_user_idx ON voice_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_usage_scenario_idx ON voice_usage (scenario_id);
