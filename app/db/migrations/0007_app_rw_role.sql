-- ============================================================================
-- Migration 0007 — Non-superuser app role so FORCE RLS actually engages (SAU-233)
-- ----------------------------------------------------------------------------
-- Why: Postgres superusers and BYPASSRLS roles bypass Row-Level Security
-- ENTIRELY — even FORCE. The docker-default `agent` role is a superuser, so the
-- Slice-5 ownership/RLS policies (migrations 0005/0006) are *inert* when the app
-- connects as `agent`: the DB-layer half of the two-layer enforcement never bites
-- (the API-layer capability/ownership guards stay active, so this is
-- defense-in-depth hardening, not an open hole). CISO triaged this post-merge
-- (SAU-231); EA flagged the same FORCE-vs-superuser gap (SAU-230).
--
-- Fix: a dedicated NON-superuser, NOBYPASSRLS login role (`app_rw`) the app uses
-- for request-serving. DDL (migrations) and the seed-as-admin path stay on the
-- owner/superuser role; only the runtime connection is restricted, so the
-- policies finally scope every row at the database.
--
-- Portability: CREATE is guarded on existence, so a production deployment can
-- pre-provision `app_rw` with its own managed password and this migration simply
-- (re)applies the grants. The literal password here is a LOCAL-DEV credential
-- only (matches the `agent:agent` convention in docker-compose/README) — never a
-- production secret.
--
-- Idempotent: guarded CREATE ROLE; GRANT / ALTER DEFAULT PRIVILEGES / CREATE OR
-- REPLACE VIEW are all safe to re-run.
-- ============================================================================

-- ── app_rw ── non-superuser, NOBYPASSRLS runtime login role ─────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        CREATE ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
            PASSWORD 'app_rw';
    END IF;
END $$;

-- Belt-and-braces: if the role was pre-created elsewhere, make sure it can never
-- silently bypass RLS. (No-op when already correct.)
ALTER ROLE app_rw NOSUPERUSER NOBYPASSRLS;

-- ── Privileges ── DML only; no DDL, no ownership ────────────────────────────
GRANT USAGE ON SCHEMA public TO app_rw;

-- Existing tables (incl. the session_history view): the app reads/writes rows
-- but never alters schema. RLS still constrains *which* rows, per migration 0005.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;

-- Sequences (none today — all PKs are gen_random_uuid() — but future-proof so a
-- later serial/identity column doesn't break inserts for the restricted role).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- Future objects created by the migration owner (this role) are auto-granted, so
-- new tables in later migrations don't need a manual GRANT to keep the app working.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- ── session_history view must run as the INVOKER, or it bypasses RLS ─────────
-- A view executes its underlying query with the view OWNER's rights and RLS
-- context by default. This view is owned by the (superuser) migration role, so
-- under the restricted app role it would STILL read every user's sessions —
-- re-opening the exact projection leak SAU-230 closed, just one indirection over.
-- `security_invoker = true` (PG15+) makes the view run as the querying role
-- (`app_rw`) so the session/analysis RLS policies engage on the History path too.
-- Re-declared verbatim from migration 0002; only the view option is added.
CREATE OR REPLACE VIEW session_history WITH (security_invoker = true) AS
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
