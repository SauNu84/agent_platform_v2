-- ============================================================================
-- Migration 0003 — Slice 3: Compositions (Course + Coach) + memory/consent
-- ----------------------------------------------------------------------------
-- Aligns to the EA canonical ERD (docs/architecture/ERD.md, SAU-175) and the
-- CISO-signed Coach memory model (docs/adr/ADR-004-coach-memory-model.md).
--
-- Stands up the tables the compositions need end-to-end on top of Slice 1:
--   coach           — Scenario + persistent memory + schedule (ADR-001 composition)
--   course          — ordered list of Scenario refs + optional coach binding
--   course_scenario — the ordered join (position = "Play All" sequence)
--   coach_memory    — per-(coach,user) derived summaries/facts (ADR-004); pgvector
--                     embeddings; **Postgres RLS mandated** as the tenancy backstop
--   consent_record  — append-only record-of-consent for memory features (ADR-004)
--   audit_log       — append-only, PII-free privacy event log (ADR-004 §audit)
--
-- session.coach_id / session.course_id already exist (nullable, added in 0001);
-- this migration adds the FKs now that the parent tables exist (expand-contract).
--
-- Migrations to compiled tables follow expand-contract — the MD compiler is
-- downstream and must never be broken mid-deploy (ADR-002 / ERD migration note).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector for coach_memory.embedding (ADR-004)

-- ── coach ── Scenario + memory + schedule (ADR-001 composition) ──────────────
-- A coach composes a Scenario (the atom). It does NOT duplicate persona/voice/
-- rubric (ADR-001) — it points at scenario_id and adds memory + schedule.
-- `inline_ai_instructions` is reserved (ERD) for an inline-persona coach that
-- compiles down to a backing scenario; Slice 3 MVP authors coaches via a
-- `scenario_ref`, so it stays null for now (tracked follow-up).
CREATE TABLE IF NOT EXISTS coach (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                   text NOT NULL UNIQUE,
    name                   text NOT NULL,
    scenario_id            uuid REFERENCES scenario (id) ON DELETE SET NULL, -- null if inline persona
    inline_ai_instructions text,                                            -- reserved (ERD); MVP: null
    memory_scope           text NOT NULL DEFAULT 'per_user'
                               CHECK (memory_scope IN ('per_user')),
    retention              text NOT NULL DEFAULT 'persistent'
                               CHECK (retention IN ('persistent', 'window')),
    schedule               jsonb NOT NULL DEFAULT '{}'::jsonb,              -- cadence, channels (ADR-004)
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coach_scenario_idx ON coach (scenario_id);

-- ── course ── ordered Scenario refs + optional coach binding ─────────────────
CREATE TABLE IF NOT EXISTS course (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text NOT NULL UNIQUE,
    name       text NOT NULL,
    visibility text NOT NULL DEFAULT 'private'
                   CHECK (visibility IN ('public', 'private')),
    coach_id   uuid REFERENCES coach (id) ON DELETE SET NULL,  -- optional binding
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS course_coach_idx ON course (coach_id);

-- ── course_scenario ── the ordered join (Play All sequence) ──────────────────
CREATE TABLE IF NOT EXISTS course_scenario (
    course_id   uuid NOT NULL REFERENCES course (id) ON DELETE CASCADE,
    scenario_id uuid NOT NULL REFERENCES scenario (id) ON DELETE CASCADE,
    position    int  NOT NULL,                       -- ordered; Play All sequence
    PRIMARY KEY (course_id, scenario_id)
);

CREATE INDEX IF NOT EXISTS course_scenario_position_idx ON course_scenario (course_id, position);

-- ── session FKs ── now that coach/course exist (expand-contract from 0001) ───
-- 0001 created session.coach_id / session.course_id as bare nullable uuids so a
-- session could be recorded before the parent tables existed. Add the FKs now.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_coach_id_fkey') THEN
        ALTER TABLE session ADD CONSTRAINT session_coach_id_fkey
            FOREIGN KEY (coach_id) REFERENCES coach (id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_course_id_fkey') THEN
        ALTER TABLE session ADD CONSTRAINT session_course_id_fkey
            FOREIGN KEY (course_id) REFERENCES course (id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS session_coach_idx ON session (coach_id);
-- Course progress query: completed sessions per (course, scenario, user).
CREATE INDEX IF NOT EXISTS session_course_idx ON session (course_id, scenario_id, user_id);

-- ── coach_memory ── per-(coach,user) derived memory (ADR-004) ────────────────
-- Stores DERIVED summaries/facts, never raw transcripts. embedding = pgvector.
-- expires_at is set at write time and drives the purge job (ADR-004 retention).
CREATE TABLE IF NOT EXISTS coach_memory (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    coach_id          uuid NOT NULL REFERENCES coach (id) ON DELETE CASCADE,
    user_id           uuid NOT NULL,
    kind              text NOT NULL CHECK (kind IN ('summary', 'fact', 'preference', 'goal')),
    content           text NOT NULL,                 -- derived, not raw transcript
    embedding         vector(1536),                  -- pgvector; ANN index below
    source_session_id uuid REFERENCES session (id) ON DELETE SET NULL,
    salience          numeric NOT NULL DEFAULT 1.0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL            -- ADR-004: summaries +365d; facts +24mo (bumped on retrieval)
);

CREATE INDEX IF NOT EXISTS coach_memory_coach_user_created_idx
    ON coach_memory (coach_id, user_id, created_at DESC);
-- ANN index for semantic retrieval (ADR-004). ivfflat/cosine — broadly available.
CREATE INDEX IF NOT EXISTS coach_memory_embedding_idx
    ON coach_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Tenancy: Postgres RLS is MANDATED on coach_memory (ADR-004 §Tenancy & RLS).
-- One missing `WHERE user_id = …` would be a cross-tenant PII breach; RLS makes
-- that bug class structurally impossible. The app sets `SET LOCAL app.user_id`
-- per request inside the transaction; the policy scopes every row to that user.
-- FORCE so even the table owner is subject to the policy (non-bypass posture).
ALTER TABLE coach_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coach_memory_user_isolation ON coach_memory;
CREATE POLICY coach_memory_user_isolation ON coach_memory
    USING (user_id = current_setting('app.user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);

-- ── consent_record ── append-only record-of-consent (ADR-004 §User controls) ─
-- A revocation is a NEW row, never an update — consent state is reconstructable
-- at any past timestamp. Retained processing-duration + 6y (outlives the memory).
CREATE TABLE IF NOT EXISTS consent_record (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL,
    scope            text NOT NULL,                  -- 'coach:<id>' | 'global'
    consent_type     text NOT NULL CHECK (consent_type IN ('persistent_memory', 'audio_retention')),
    action           text NOT NULL CHECK (action IN ('granted', 'revoked')),
    policy_version   text,
    policy_text_hash text,                           -- proves exact wording agreed to
    locale           text,
    ui_surface       text,
    source_ip        inet,
    user_agent       text,
    created_at       timestamptz NOT NULL DEFAULT now()  -- append-only; event time
);

CREATE INDEX IF NOT EXISTS consent_record_user_scope_idx
    ON consent_record (user_id, scope, created_at DESC);

-- ── audit_log ── append-only, PII-free privacy event log (ADR-004 §audit) ────
-- Logs memory write/retrieval/delete, consent change, export, DSAR action, and
-- staff access. Contains IDs/counts/references only — NEVER PII content.
CREATE TABLE IF NOT EXISTS audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ts              timestamptz NOT NULL DEFAULT now(),
    actor           text NOT NULL,                  -- 'user:<id>' | 'system' | 'staff:<id>'
    event           text NOT NULL,                  -- memory.write|memory.retrieve|memory.delete|consent.grant|...
    subject_user_id uuid,
    coach_id        uuid,
    refs            jsonb NOT NULL DEFAULT '{}'::jsonb  -- counts/ids only; NO PII content
);

CREATE INDEX IF NOT EXISTS audit_log_subject_idx ON audit_log (subject_user_id, ts DESC);
