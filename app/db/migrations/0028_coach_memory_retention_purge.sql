-- ============================================================================
-- Migration 0028 — coach_memory retention purge: a DELETE-only, expired-only RLS
--                   policy for the scheduled system purge (SAU-557 · CISO SAU-558 C1)
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ADR-004 §1 says summaries expire after 365 days and facts after 24 months
-- without retrieval, but nothing ever DELETED an expired row. `listCoachMemory`
-- only hid rows past `expires_at`. That was invisible while every user was
-- active. With pause-on-downgrade (SAU-557), expiry is the ONLY way a paused
-- user's memories go away, so without a purge "paused" meant "kept forever"
-- (CISO SAU-558 C1, release blocker).
--
-- WHY A POLICY
-- coach_memory is FORCE RLS keyed on `app.user_id` only (0003). A system job
-- running as app_rw can't see or delete any row, and there is no admin bypass on
-- this table. Rather than give the job a superuser/BYPASSRLS credential, this adds
-- the narrowest grant that does the job:
--   • FOR DELETE only, and only while `app.is_admin = 'on'`;
--   • only rows whose `expires_at` has passed.
-- No SELECT policy is added. Postgres applies SELECT policies to a DELETE only
-- when the command READS columns (a WHERE or RETURNING), so the purge's
-- unqualified `DELETE FROM coach_memory` removes exactly the expired rows and never
-- reads one. The job sees a row count and no memory content. Admin-context code
-- still can't read coach memory.
--
-- Separate from the SAU-285 PHI purge by ruling: different table, different
-- windows (ADR-004, not retention-policy.ts), and its own audit row (audit_log
-- `memory.purge`). Run by `npm run purge:coach-memory` (≤ 7-day cadence).
-- ============================================================================

DROP POLICY IF EXISTS coach_memory_retention_purge ON coach_memory;
CREATE POLICY coach_memory_retention_purge ON coach_memory
    FOR DELETE
    USING (current_setting('app.is_admin', true) = 'on' AND expires_at <= now());
