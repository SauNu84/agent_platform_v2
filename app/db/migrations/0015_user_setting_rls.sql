-- ============================================================================
-- Migration 0015 — FORCE RLS on user_setting (SAU-262 / SAU-260 CISO gate)
-- ----------------------------------------------------------------------------
-- Why: user_setting (migration 0012) shipped as application-layer only ("no
-- secret/PII content is stored"). That assumption no longer holds — SAU-259/261
-- store BYO provider API keys here under `model_api_key:<provider>` (and the
-- legacy `voice_gemini_live_key`). Even though the values are now AES-256-GCM
-- ciphertext at rest (SAU-261, lib/crypto.ts), the table holds per-user secrets
-- and MUST carry the same database-level ownership boundary every other per-user
-- table got in Slice 5. Without it, the NOBYPASSRLS `app_rw` runtime role
-- (migration 0007) can read EVERY user's rows if any query path forgets its
-- `WHERE user_id = $1` app-layer filter — exactly the projection leak class
-- SAU-230 closed for analysis/voice_usage/session_event.
--
-- Fix: enable + FORCE row-level security and scope every row to the request
-- actor's `app.user_id` GUC, with the same `app.is_admin` break-glass bypass the
-- other policies use (DSAR/support). Verbatim shape of the analysis/voice_usage
-- owner policy in migration 0006 so the enforcement model stays uniform.
--
-- app_rw subjection: app_rw is NOSUPERUSER NOBYPASSRLS (migration 0007), and
-- FORCE ROW LEVEL SECURITY also subjects the table OWNER, so neither the runtime
-- role nor the migration owner can sidestep this policy. Superuser (`agent`,
-- local dev/DDL/seed) still bypasses by definition — runtime serving uses app_rw.
--
-- Idempotent: ENABLE/FORCE are no-ops if already set; DROP POLICY IF EXISTS +
-- CREATE re-asserts cleanly. Safe to re-run.
-- ============================================================================

ALTER TABLE user_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_setting FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_setting_owner ON user_setting;
CREATE POLICY user_setting_owner ON user_setting FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );
