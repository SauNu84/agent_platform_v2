-- ============================================================================
-- Migration 0005 — Slice 5: Login (AuthN) + capability-based RBAC + ownership
-- ----------------------------------------------------------------------------
-- Implements ADR-007 rev 3 (capability-based RBAC) and SAU-229. Replaces the
-- pre-auth DEMO_USER_ID stub with a real identity + role model and lands the
-- ownership/RLS backstop so per-user rows are scoped at the database, not just
-- the app layer.
--
-- Design notes:
--   * Identity is intentionally minimal (email + password hash). The auth
--     *provider* is a seam in the app (src/auth/provider.ts); this table is the
--     local-credential backing store. Swap for org SSO without a schema change.
--   * Roles are CONFIG, not code: `user_role` maps a user to a role, and
--     `role_capability` maps a role to atomic capabilities (ADR-007). Adding or
--     splitting a role later is a data change, not a migration.
--   * MVP ships 2 roles (`user`, `admin`); `operator` is also seeded so role
--     differentiation is testable now even though MVP UI gates on user/admin.
--   * Ownership + RLS mirror the proven coach_memory pattern (0003): the app
--     sets `app.user_id` (and `app.is_admin`) per request inside a transaction;
--     policies scope every row. FORCE so even the table owner is subject to it.
--   * Public reads keep working via `is_public` / `course.visibility` /
--     null-owner (platform/seeded content) even when no user context is set, so
--     anonymous catalog browsing and the share-link path are unaffected.
--
-- Out of scope (deferred to B2B — ADR-007): assignment model, org_id multi-
-- tenancy, data_class/PHI gating, billing role gates. Seams only, no build.
--
-- Expand-contract: new owner columns are NULLABLE (platform content has no
-- owner); the session.user_id FK is added NOT VALID so legacy rows aren't
-- retro-validated while new writes are enforced.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ── app_user ── local identity (email + password hash) ──────────────────────
-- Email stored lower-cased by the app; the UNIQUE index enforces one account
-- per address. password_hash is a self-describing scrypt string (see
-- src/auth/password.ts) — never a plaintext or reversible value.
CREATE TABLE IF NOT EXISTS app_user (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    display_name  text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── auth_session ── server-side session tokens (login → cookie) ─────────────
-- The opaque token is the httpOnly cookie value; the row is the source of truth
-- so logout/expiry are server-enforced (a stolen-then-revoked cookie is dead).
CREATE TABLE IF NOT EXISTS auth_session (
    token      text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_session_user_idx ON auth_session (user_id);

-- ── user_role ── user → role (config, not code) ─────────────────────────────
-- PK on (user_id, role) allows multiple roles per user in future; MVP assigns
-- exactly one. Role names are free text resolved against role_capability.
CREATE TABLE IF NOT EXISTS user_role (
    user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    role    text NOT NULL,
    PRIMARY KEY (user_id, role)
);

-- ── role_capability ── role → atomic capability bundle (ADR-007) ────────────
-- The capability vocabulary is fixed (CHECK); the bundling into roles is data,
-- so roles are editable config. This is the table that makes "don't mint a role
-- per job title" real — a role is just its rows here.
CREATE TABLE IF NOT EXISTS role_capability (
    role       text NOT NULL,
    capability text NOT NULL CHECK (capability IN (
        'practice', 'author_content', 'assign_to_users', 'view_identified_results',
        'manage_org_members', 'manage_billing', 'platform_admin'
    )),
    PRIMARY KEY (role, capability)
);

-- Seed the MVP + (defined-but-unused-in-UI) operator bundles. Idempotent.
INSERT INTO role_capability (role, capability) VALUES
    -- user: consumer model — practice + author/remix own content (ADR-007).
    ('user', 'practice'),
    ('user', 'author_content'),
    -- admin: every capability (platform operation).
    ('admin', 'practice'),
    ('admin', 'author_content'),
    ('admin', 'assign_to_users'),
    ('admin', 'view_identified_results'),
    ('admin', 'manage_org_members'),
    ('admin', 'manage_billing'),
    ('admin', 'platform_admin'),
    -- operator (B2B; defined now so role differentiation is testable): authoring
    -- + the privacy step-up (assign + view identified results). No org/billing.
    ('operator', 'practice'),
    ('operator', 'author_content'),
    ('operator', 'assign_to_users'),
    ('operator', 'view_identified_results')
ON CONFLICT (role, capability) DO NOTHING;

-- ── Ownership columns (nullable; null = platform/seeded content) ─────────────
ALTER TABLE scenario ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL;
ALTER TABLE coach    ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL;
ALTER TABLE course   ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES app_user (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS scenario_owner_idx ON scenario (owner_user_id);
CREATE INDEX IF NOT EXISTS coach_owner_idx    ON coach (owner_user_id);
CREATE INDEX IF NOT EXISTS course_owner_idx   ON course (owner_user_id);

-- session.user_id existed since 0001 as a bare uuid; add the FK now (NOT VALID
-- so any pre-auth demo rows aren't retro-checked, new writes are enforced).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_user_id_fkey') THEN
        ALTER TABLE session ADD CONSTRAINT session_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE SET NULL NOT VALID;
    END IF;
END $$;

-- ── Row-Level Security (FORCE) — ownership + public-read backstop ────────────
-- GUCs the app sets per request (src/db/pg-store.ts, mirroring coach_memory):
--   app.user_id  — the authenticated user's uuid (empty string if anonymous)
--   app.is_admin — 'on' when the user holds platform_admin (full bypass)
-- nullif(...,'') turns an unset/empty GUC into SQL NULL so the owner comparison
-- is simply false for anonymous requests (public rows still read).

-- helper expressions (inlined per policy):
--   owner match : owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
--   admin       : current_setting('app.is_admin', true) = 'on'

-- scenario ---------------------------------------------------------------------
ALTER TABLE scenario ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scenario_read ON scenario;
CREATE POLICY scenario_read ON scenario FOR SELECT USING (
    is_public
    OR owner_user_id IS NULL
    OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR current_setting('app.is_admin', true) = 'on'
);
DROP POLICY IF EXISTS scenario_write ON scenario;
CREATE POLICY scenario_write ON scenario FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

-- coach ------------------------------------------------------------------------
-- Coaches have no is_public flag; platform coaches (null owner) are world-read.
ALTER TABLE coach ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coach_read ON coach;
CREATE POLICY coach_read ON coach FOR SELECT USING (
    owner_user_id IS NULL
    OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR current_setting('app.is_admin', true) = 'on'
);
DROP POLICY IF EXISTS coach_write ON coach;
CREATE POLICY coach_write ON coach FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

-- course -----------------------------------------------------------------------
ALTER TABLE course ENABLE ROW LEVEL SECURITY;
ALTER TABLE course FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS course_read ON course;
CREATE POLICY course_read ON course FOR SELECT USING (
    visibility = 'public'
    OR owner_user_id IS NULL
    OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR current_setting('app.is_admin', true) = 'on'
);
DROP POLICY IF EXISTS course_write ON course;
CREATE POLICY course_write ON course FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

-- session ----------------------------------------------------------------------
-- A session is private to the user who ran it (transcripts/scores). No public
-- read: only the owner or an admin (DSAR/support) may see a session row.
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE session FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_owner ON session;
CREATE POLICY session_owner ON session FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

-- ── Session projections (analysis / voice_usage / session_event) ─────────────
-- These carry *identified* per-user results (report cards/scores, metering, raw
-- transcript turns) and are queried DIRECTLY by session_id, so the `session`
-- policy above does NOT cascade to them. Without their own policies a caller
-- with a session UUID could read another user's analysis/transcript via the
-- projection (e.g. GET /api/sessions/[id]/analyze → SELECT … WHERE session_id=$1).
-- This is the `view_identified_results` boundary (ADR-007) and the canonical ERD
-- already states RLS should extend to session/session_event/analysis. (SAU-230)
--
-- analysis + voice_usage carry a denormalized user_id → scope by it directly,
-- mirroring session_owner. session_event has no user_id → scope via its parent
-- session's user_id (the parent is itself RLS-protected, so the subquery is
-- doubly safe).

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
