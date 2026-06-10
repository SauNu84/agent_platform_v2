-- ============================================================================
-- Migration 0006 — Slice 5 follow-up: FORCE RLS on the session projections
-- ----------------------------------------------------------------------------
-- EA/CISO required (SAU-230 / SAU-231): the per-user session projections
-- `analysis`, `voice_usage`, and `session_event` are queried directly by
-- session_id (e.g. GET /api/sessions/[id]/analyze), so the `session` ownership
-- policy does NOT cascade to them — a non-owner who knows a session UUID could
-- read another user's report card / transcript / usage. This is the
-- `view_identified_results` boundary (ADR-007) and the canonical ERD already
-- states RLS should extend here.
--
-- Why a SEPARATE migration (not an edit to 0005): the forward-only runner is
-- idempotent and SKIPS any migration already recorded in schema_migrations.
-- Databases that applied an earlier 0005 (before the projection policies were
-- added) would never pick the fix up from an in-place 0005 edit. Shipping it as
-- 0006 guarantees every environment — fresh or already-on-0005 — converges.
-- Every statement here is itself idempotent (ENABLE/FORCE are no-ops if already
-- set; DROP POLICY IF EXISTS + CREATE re-asserts cleanly), so this is safe to
-- run on a DB that already got these policies via the current 0005.
--
-- Scoping: analysis + voice_usage carry a denormalized user_id → scope directly,
-- mirroring session_owner. session_event has no user_id → scope via its parent
-- session's user_id (the parent is itself RLS-protected, so the subquery is
-- doubly safe). admin (app.is_admin = 'on') bypasses for DSAR/support.
-- ============================================================================

-- analysis ----------------------------------------------------------------------
ALTER TABLE analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analysis_owner ON analysis;
CREATE POLICY analysis_owner ON analysis FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

-- voice_usage -------------------------------------------------------------------
ALTER TABLE voice_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_usage_owner ON voice_usage;
CREATE POLICY voice_usage_owner ON voice_usage FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

-- session_event -----------------------------------------------------------------
-- No user_id column; scope to the parent session's owner. The EXISTS subquery is
-- itself filtered by session's RLS, so a non-owner sees no parent → no events.
ALTER TABLE session_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_event_owner ON session_event;
CREATE POLICY session_event_owner ON session_event FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM session s
            WHERE s.id = session_event.session_id
              AND s.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        )
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM session s
            WHERE s.id = session_event.session_id
              AND s.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        )
    );
