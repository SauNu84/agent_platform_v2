-- ============================================================================
-- Migration 0018 — Multi-clinic (org) row scoping + PHI access audit log (SAU-275)
-- ----------------------------------------------------------------------------
-- Phase 1 · WS5. First-class blocker on the HIPAA/PHI go-live gate (SAU-272).
-- Closes two gaps the earlier slices deliberately deferred:
--
--   1. ORG/CLINIC SCOPING (ends the SAU-231 B2B deferral). The Slice-5 RLS
--      policies (0005/0006) are PER-USER-OWNER only — there is no cross-org
--      tenant boundary, and the PHI-bearing `clinic_session_outcome` table
--      (0016) had NO RLS at all (it shipped "synthetic-only, same footing as
--      voice_usage"). Multi-clinic PHI isolation requires a real tenant column
--      so Clinic A can never read Clinic B's patient data.
--
--   2. PHI ACCESS AUDIT LOG (§164.312(b)). An append-only, tamper-evident record
--      of who/what/when for every PHI read & write — including PROGRAMMATIC AGENT
--      access during a live call. Queryable by patient-session and by clinic.
--
-- New per-request GUC (set by PgStore alongside app.user_id / app.is_admin):
--   app.clinic_id — the acting user's clinic uuid ('' / unset for platform users)
--
-- Expand-contract: every new column is NULLABLE (legacy/platform rows have no
-- clinic); FKs are added guarded. Idempotent throughout (IF NOT EXISTS / DROP+
-- CREATE POLICY / guarded DO blocks), consistent with the forward-only runner.
-- Audit-log schema coordinated with CISO (SAU-272/276).
-- ============================================================================

-- ── clinic ── the tenant/org (a medical practice) ───────────────────────────
CREATE TABLE IF NOT EXISTS clinic (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text NOT NULL UNIQUE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- A user belongs to at most one clinic (MVP). Platform/consumer users have NULL
-- clinic_id and are unaffected by clinic scoping. Multi-clinic staff is a future
-- join-table change; one column keeps the per-request GUC a single value.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS clinic_id uuid REFERENCES clinic (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS app_user_clinic_idx ON app_user (clinic_id);

-- The PHI rows are rooted at a session; tag the session (and the denormalized
-- booking outcome) with the clinic that owns the patient interaction.
ALTER TABLE session                ADD COLUMN IF NOT EXISTS clinic_id uuid REFERENCES clinic (id) ON DELETE SET NULL;
ALTER TABLE clinic_session_outcome ADD COLUMN IF NOT EXISTS clinic_id uuid REFERENCES clinic (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS session_clinic_idx        ON session (clinic_id);
CREATE INDEX IF NOT EXISTS clinic_outcome_clinic_idx ON clinic_session_outcome (clinic_id);

-- ── clinic RLS ── a user reads only their own clinic row (admin bypass) ──────
ALTER TABLE clinic ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clinic_read ON clinic;
CREATE POLICY clinic_read ON clinic FOR SELECT USING (
    current_setting('app.is_admin', true) = 'on'
    OR id = nullif(current_setting('app.clinic_id', true), '')::uuid
);
-- Only admins write clinic rows (tenant provisioning is a privileged operation).
DROP POLICY IF EXISTS clinic_admin_write ON clinic;
CREATE POLICY clinic_admin_write ON clinic FOR ALL
    USING (current_setting('app.is_admin', true) = 'on')
    WITH CHECK (current_setting('app.is_admin', true) = 'on');

-- ── session: extend ownership policy with same-clinic visibility ─────────────
-- A session is readable/writable by: an admin, the user who ran it (existing
-- behavior), OR a member of the SAME clinic (clinic staff reviewing their
-- practice's bookings). A different clinic's user matches none of these → a
-- Clinic A session is invisible to a Clinic B user. Replaces session_owner (0005)
-- with a superset that adds the clinic dimension; user-only rows (clinic_id NULL)
-- keep their exact prior semantics because the clinic clause requires a non-NULL
-- match on BOTH sides.
DROP POLICY IF EXISTS session_owner ON session;
CREATE POLICY session_owner ON session FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
        OR (clinic_id IS NOT NULL AND clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid)
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
        OR (clinic_id IS NOT NULL AND clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid)
    );

-- ── clinic_session_outcome RLS ── FIRST-EVER policy on this PHI table ────────
-- 0016 left this table RLS-free (synthetic-only). It carries the encrypted
-- patient `intake` (name/DOB/reason/insurance) → it MUST be tenant-scoped before
-- any real patient. Scope by its own clinic_id (admin/owner-user also allowed so
-- the operator who ran the call and DSAR/support still work).
ALTER TABLE clinic_session_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_session_outcome FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clinic_outcome_scoped ON clinic_session_outcome;
CREATE POLICY clinic_outcome_scoped ON clinic_session_outcome FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
        OR (clinic_id IS NOT NULL AND clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid)
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
        OR (clinic_id IS NOT NULL AND clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid)
    );

-- ============================================================================
-- PHI ACCESS AUDIT LOG — append-only, tamper-evident (§164.312(b))
-- ----------------------------------------------------------------------------
-- One row per PHI read/write at the pg-store boundary. `actor_user_id` is the
-- authenticated user when present; `actor_label` always names the principal,
-- including programmatic agents during a call (e.g. 'agent:clinic-intake'),
-- so agent access is captured, not just human UI access.
--
-- Tamper-evidence is two-layered:
--   * content integrity — `integrity` is an HMAC-SHA256 (server key) over the
--     row's canonical content (lib/crypto.hmac). Editing any logged field
--     invalidates it; it cannot be re-forged without the key.
--   * append-only — UPDATE/DELETE are revoked from the runtime role AND blocked
--     by a trigger (so even a future grant or the table owner cannot mutate/
--     delete a logged row). INSERT + SELECT only.
-- `seq` (bigserial) gives a monotonic, gap-detectable ordering for review.
-- ============================================================================
CREATE TABLE IF NOT EXISTS phi_access_log (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq           bigint GENERATED ALWAYS AS IDENTITY,
    ts            timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid,                       -- authenticated user, when present
    actor_label   text NOT NULL,              -- 'user:<id>' | 'agent:<scenario>' | 'system' | 'anonymous'
    action        text NOT NULL CHECK (action IN ('read', 'write')),
    entity        text NOT NULL,              -- 'clinic_session_outcome.intake' | 'session.transcript' | 'session_event.payload'
    entity_id     text,                       -- session id (the PHI subject key)
    clinic_id     uuid,                       -- tenant the PHI belongs to (when known)
    refs          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- counts/ids only — NEVER PHI content
    integrity     text NOT NULL               -- base64 HMAC-SHA256 over the canonical row
);

CREATE INDEX IF NOT EXISTS phi_access_entity_idx ON phi_access_log (entity_id, ts DESC);
CREATE INDEX IF NOT EXISTS phi_access_clinic_idx ON phi_access_log (clinic_id, ts DESC);
CREATE INDEX IF NOT EXISTS phi_access_actor_idx  ON phi_access_log (actor_user_id, ts DESC);

-- Append-only at the DB: block UPDATE/DELETE for everyone (incl. the owner under
-- FORCE) via a trigger that always raises. Belt-and-braces with the privilege
-- revoke below.
CREATE OR REPLACE FUNCTION phi_access_log_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'phi_access_log is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS phi_access_log_no_mutate ON phi_access_log;
CREATE TRIGGER phi_access_log_no_mutate
    BEFORE UPDATE OR DELETE ON phi_access_log
    FOR EACH ROW EXECUTE FUNCTION phi_access_log_append_only();

-- RLS: a caller may INSERT log rows and SELECT their own clinic's rows (admins
-- see all, for compliance review). No UPDATE/DELETE policy → none possible.
ALTER TABLE phi_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE phi_access_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS phi_access_insert ON phi_access_log;
CREATE POLICY phi_access_insert ON phi_access_log FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS phi_access_read ON phi_access_log;
CREATE POLICY phi_access_read ON phi_access_log FOR SELECT USING (
    current_setting('app.is_admin', true) = 'on'
    OR actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR (clinic_id IS NOT NULL AND clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid)
);

-- Runtime role gets INSERT/SELECT only on the audit log (no UPDATE/DELETE), so
-- the append-only guarantee survives even if the trigger were ever dropped.
-- (0007 granted ALL DML by default; tighten this one table.)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON phi_access_log FROM app_rw;
        GRANT INSERT, SELECT ON phi_access_log TO app_rw;
    END IF;
END $$;

COMMENT ON TABLE phi_access_log IS
  'PHI access audit (SAU-275, §164.312(b)): append-only, HMAC-tamper-evident who/what/when for every PHI read/write incl. programmatic agent access. refs holds counts/ids only — never PHI content.';
