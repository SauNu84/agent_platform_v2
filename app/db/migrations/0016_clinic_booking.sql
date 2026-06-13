-- ============================================================================
-- Migration 0016 — Clinic Intake & Booking outcome (SAU-267, Phase 0)
-- ----------------------------------------------------------------------------
-- The platform's NEW task-completion model, distinct from the analyst SCORING
-- projection (analysis, 0002). Where `analysis` grades a human learner 0–100,
-- this records whether the action-taking agent COMPLETED its task: it booked an
-- appointment (with the created calendar event id as proof), found no slot, or
-- escalated to a human. One row per session.
--
-- It also stores the post-session structured intake JSON (name/DOB/reason/
-- insurance/preferred times) extracted from the transcript (AC #4/#5).
--
-- Phase-0 scope: SYNTHETIC patients only — no real PHI. We deliberately keep this
-- on the same app-layer, session-scoped footing as voice_usage (no RLS). The PHI
-- boundary (encryption at rest, RLS, retention, audit) is being scoped by CISO in
-- a sibling issue and gates Phase 1, not this spike.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clinic_session_outcome (
    session_id    uuid PRIMARY KEY REFERENCES session (id) ON DELETE CASCADE,
    scenario_id   uuid NOT NULL REFERENCES scenario (id) ON DELETE CASCADE,
    user_id       uuid,
    outcome       text NOT NULL CHECK (outcome IN ('booked', 'no_slot', 'escalated')),
    event_id      text,                 -- vendor calendar event id (proof of booking)
    event_link    text,                 -- htmlLink when the vendor provides one
    doctor_id     text,
    doctor_name   text,
    slot_start    timestamptz,
    slot_end      timestamptz,
    calendar      text,                 -- adapter label, e.g. "Simulated calendar (sandbox)"
    simulated     boolean NOT NULL DEFAULT true,
    intake        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clinic_outcome_scenario_idx ON clinic_session_outcome (scenario_id);
CREATE INDEX IF NOT EXISTS clinic_outcome_user_idx ON clinic_session_outcome (user_id);
