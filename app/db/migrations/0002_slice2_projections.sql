-- ============================================================================
-- Migration 0002 — Slice 2: projections (Analyst + History) + credit meter
-- ----------------------------------------------------------------------------
-- Aligns to the EA ERD (docs/architecture/ERD.md, SAU-175). Slice 2 adds the
-- read-models over `session` plus the monetization guardrail:
--   analysis         — Analyst rubric scoring of a completed session (projection)
--   user_entitlement — per-user plan + free/paid voice-minute caps (cap enforcement)
--   session_history  — per-user activity VIEW (read-model over session + analysis)
--
-- Nothing here is a new conversation engine — both Analyst and History are
-- projections over the Slice-1 `session`/`voice_usage` facts (ERD model notes).
--
-- Expand-contract: all additions are IF NOT EXISTS / additive; no Slice-1 table
-- is altered. `session.user_id` stays a nullable uuid WITHOUT an FK (the user
-- table still hasn't landed); `user_entitlement.user_id` is the same: a bare uuid
-- key, FK added when the identity model lands.
-- ============================================================================

-- ── analysis ── Analyst projection over a completed session (ADR-001 rubric) ──
-- One row per session (UNIQUE). The Analyst worker scores the transcript against
-- the scenario `rubric` and writes the report card + improvement plan here.
-- Column shape mirrors the reference API evaluation/improvement payloads.
CREATE TABLE IF NOT EXISTS analysis (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    uuid NOT NULL UNIQUE REFERENCES session (id) ON DELETE CASCADE,
    scenario_id   uuid NOT NULL REFERENCES scenario (id) ON DELETE CASCADE,
    user_id       uuid,                          -- denormalized for per-user History join
    scorer        text NOT NULL,                 -- which Scorer produced this (heuristic|llm:<model>)
    overall_score numeric(5,2) NOT NULL DEFAULT 0,
    final_score   numeric(5,2) NOT NULL DEFAULT 0,
    report_card   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{topic,score,weight,note}]
    strengths     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [text]
    weaknesses    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [text]
    improvement   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {areas:[text], action_items:[text]}
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Hot indexes per ERD: analysis(session_id) UNIQUE (above) + per-scenario rollup.
CREATE INDEX IF NOT EXISTS analysis_scenario_idx ON analysis (scenario_id);
CREATE INDEX IF NOT EXISTS analysis_user_idx ON analysis (user_id, created_at DESC);

-- ── user_entitlement ── per-user voice-minute plan + caps (MVP monetization) ──
-- Cap enforcement reads (used minutes from voice_usage) vs (free + paid minutes).
-- A missing row means "default free plan" (resolved in the meter service), so a
-- brand-new user is metered without a provisioning step.
CREATE TABLE IF NOT EXISTS user_entitlement (
    user_id       uuid PRIMARY KEY,              -- bare uuid; FK when user table lands
    plan          text NOT NULL DEFAULT 'free'
                      CHECK (plan IN ('free', 'paid')),
    free_minutes  numeric(12,4) NOT NULL DEFAULT 30,   -- free-tier voice minutes
    paid_minutes  numeric(12,4) NOT NULL DEFAULT 0,    -- additional paid cap on top
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── session_history ── per-user activity timeline (read-model VIEW) ───────────
-- The History tab is a projection, NOT a base table (ERD model notes). The app
-- reads it via the Store so the in-memory impl can mirror it; this VIEW is the
-- production source-of-truth and documents the canonical join.
CREATE OR REPLACE VIEW session_history AS
SELECT s.id                              AS session_id,
       s.user_id,
       s.scenario_id,
       sc.slug                           AS scenario_slug,
       sc.name                           AS scenario_name,
       s.started_at,
       s.ended_at,
       EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) * 1000 AS duration_ms,
       s.status,
       (a.id IS NOT NULL)                AS analyzed,
       a.final_score
FROM session s
JOIN scenario sc ON sc.id = s.scenario_id
LEFT JOIN analysis a ON a.session_id = s.id;
