-- ============================================================================
-- Migration 0021 — Multi-clinic tenancy: memberships + per-clinic config (SAU-301, Phase 2 · WS-B)
-- ----------------------------------------------------------------------------
-- WS-A (SAU-300) made a clinic self-service AUTHORABLE, but stored ONE definition
-- per operator (user_setting 'clinic_config'). WS-B runs *many* clinics with a
-- switcher and a per-clinic ops dashboard, on the SAU-275 clinic_id/RLS foundation
-- (migration 0018). This migration adds exactly what multi-tenancy needs and
-- nothing else:
--
--   1. clinic.config (jsonb) — the authored ClinicConfig stored ON the clinic row
--      (non-PHI: hours/doctors/services/rules/greeting; tokens & PHI stay in their
--      own encrypted/scoped records). Makes the definition clinic-scoped, not
--      user-scoped, so two clinics owned by the same operator are independent.
--   2. clinic.created_by_user_id — provenance + the self-provision RLS check.
--   3. clinic_member — which users may act for which clinics (the switcher's list
--      + the membership gate for selecting an active clinic). 0018 anticipated
--      this ("Multi-clinic staff is a future join-table change").
--
-- RLS is strictly ADDITIVE. The CISO-approved 0018 policies (clinic_read /
-- clinic_admin_write / session_owner / clinic_outcome_scoped) are LEFT UNTOUCHED.
-- Postgres combines permissive policies per-command with OR, so the new policies
-- only *widen* access to a user's own clinics — they cannot loosen the PHI
-- isolation on session / clinic_session_outcome / clinic_notification, which keep
-- scoping every patient row by app.clinic_id exactly as before. A user who is not
-- a member of clinic B still matches none of B's row policies.
--
-- Self-service provisioning: 0018 made clinic writes admin-only (tenant creation
-- was a privileged op). Phase 2 is *self-service*, so an operator may create their
-- own clinic (INSERT gated to rows they stamp as created_by_user_id = self) and
-- edit clinics they belong to (UPDATE gated by membership). Admins keep full
-- control via the existing clinic_admin_write policy.
--
-- Expand-contract + idempotent throughout (IF NOT EXISTS / DROP+CREATE POLICY /
-- guarded DO), consistent with the forward-only runner. New table is covered by
-- the 0007 ALTER DEFAULT PRIVILEGES grant to app_rw; we re-grant explicitly too.
-- ============================================================================

-- ── per-clinic authored definition + provenance ─────────────────────────────
ALTER TABLE clinic ADD COLUMN IF NOT EXISTS config             jsonb;
ALTER TABLE clinic ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL;

-- ── after-hours capture signal for the ops dashboard (SAU-287 ROI criteria) ──
-- Derived at finalize from the clinic hours (domain/escalation.isAfterHours); lets
-- the dashboard show "after-hours captured vs dropped" without re-deriving from PHI.
-- Nullable: legacy rows predate the signal (counted as in-hours / unknown).
ALTER TABLE clinic_session_outcome ADD COLUMN IF NOT EXISTS after_hours boolean;

-- ── clinic_member ── user ↔ clinic membership (switcher + active-clinic gate) ─
CREATE TABLE IF NOT EXISTS clinic_member (
    clinic_id  uuid NOT NULL REFERENCES clinic (id)   ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    role       text NOT NULL DEFAULT 'owner',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (clinic_id, user_id)
);
CREATE INDEX IF NOT EXISTS clinic_member_user_idx ON clinic_member (user_id);

-- A user sees and manages only their OWN membership rows (admin bypass). This is
-- the source of truth for "which clinics may I switch to".
ALTER TABLE clinic_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clinic_member_self ON clinic_member;
CREATE POLICY clinic_member_self ON clinic_member FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

-- ── additive clinic policies (OR-combined with the 0018 admin/active-clinic ones)
-- Read any clinic I'm a member of (so the switcher can list more than the single
-- currently-active app.clinic_id).
DROP POLICY IF EXISTS clinic_member_read ON clinic;
CREATE POLICY clinic_member_read ON clinic FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM clinic_member m
        WHERE m.clinic_id = clinic.id
          AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));

-- Self-provision: an operator may create a clinic they stamp as their own.
DROP POLICY IF EXISTS clinic_self_provision ON clinic;
CREATE POLICY clinic_self_provision ON clinic FOR INSERT
    WITH CHECK (created_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- Creator can always read their own clinic. Needed so the INSERT ... RETURNING in
-- self-provisioning succeeds (the membership row doesn't exist yet at insert time,
-- and app.clinic_id isn't pointed at the brand-new clinic), and so an owner can
-- read a clinic they created even before/without an explicit membership row.
DROP POLICY IF EXISTS clinic_creator_read ON clinic;
CREATE POLICY clinic_creator_read ON clinic FOR SELECT
    USING (created_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- Edit (e.g. author the config of) a clinic I belong to.
DROP POLICY IF EXISTS clinic_member_update ON clinic;
CREATE POLICY clinic_member_update ON clinic FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM clinic_member m
        WHERE m.clinic_id = clinic.id
          AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM clinic_member m
        WHERE m.clinic_id = clinic.id
          AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));

-- ── runtime grants (explicit; 0007 default-privileges also covers new tables) ─
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON clinic_member TO app_rw;
    END IF;
END $$;
