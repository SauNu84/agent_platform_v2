-- ============================================================================
-- Migration 0004 — Share links (SAU-225)
-- ----------------------------------------------------------------------------
-- A Share button on the scenario detail page mints a short, URL-safe code that
-- resolves (via GET /s/{code}) back to the scenario. The mapping is idempotent
-- per scenario: re-clicking Share returns the SAME link. That invariant is
-- enforced structurally by UNIQUE (scenario_id) — the app INSERTs with
-- ON CONFLICT (scenario_id) DO NOTHING and reads the existing row back.
--
-- ON DELETE CASCADE: a deleted scenario takes its share link with it (a dangling
-- code would only ever 404).
-- ============================================================================

CREATE TABLE IF NOT EXISTS share_link (
    code        text PRIMARY KEY,                                   -- short, URL-safe
    scenario_id uuid NOT NULL UNIQUE REFERENCES scenario (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_link_scenario_idx ON share_link (scenario_id);
