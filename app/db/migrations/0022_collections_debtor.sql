-- ============================================================================
-- Migration 0022 — Collections: debtor data model + PII at rest + compliance
--                   audit ledger (SAU-333, WS-2 · parent SAU-328)
-- ----------------------------------------------------------------------------
-- The foundation data layer for the AI Call Center (collections) use case.
-- SCOPE: SYNTHETIC debtors only — nothing here can place a real call.
--
-- It REUSES the clinic stack's proven multi-tenant primitives rather than forking
-- a parallel set (minimal net-new, per the WS-2 brief):
--   • Tenant = the existing `clinic` row. A clinic REPRESENTS A LENDER here; the
--     debtor's `clinic_id` is the lender's tenant id, scoped by the SAME
--     `app.clinic_id` RLS GUC that 0018/0021 established. We do not introduce a
--     second tenant table or a second copy of the RLS plumbing.
--   • PII at rest = the SAU-274 AES-256-GCM envelope (lib/phi). The debtor's
--     identifying fields (name/phone/balance) live in ONE encrypted `pii` jsonb
--     column ({ "_enc": "iv:ct:tag" } at rest); operational/compliance fields
--     (timezone/state/consent/opt-out/dispute) stay plaintext so WS-1's pure
--     decision engine + RLS work without decrypting PII.
--   • Append-only audit = the phi_access_log design (SAU-275): bigserial seq +
--     HMAC tamper-evidence + REVOKE/trigger append-only. `collections_audit_log`
--     adds a per-tenant HASH CHAIN (each row commits to the prior one) for
--     guardrail 10, and is un-erasable even by a tenant admin.
--
-- RLS is strictly ADDITIVE: only NEW tables get policies; nothing existing is
-- touched. Expand-contract + idempotent throughout (IF NOT EXISTS / DROP+CREATE
-- POLICY / guarded DO), consistent with the forward-only runner. New tables are
-- covered by the 0007 ALTER DEFAULT PRIVILEGES grant to app_rw; we re-grant
-- explicitly too.
-- ============================================================================

-- ── debtor ── one synthetic debtor, scoped to a lender (clinic) tenant ───────
CREATE TABLE IF NOT EXISTS debtor (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id    uuid NOT NULL REFERENCES clinic (id) ON DELETE CASCADE,  -- the lender tenant
    external_ref text NOT NULL,                 -- lender's own debtor key (opaque, NOT PII)
    -- PII AT REST: encrypted envelope over { name, phone, balanceCents } (lib/phi).
    -- On disk only the ciphertext is present — never the debtor's name/phone/balance.
    pii          jsonb NOT NULL,
    -- Operational / compliance fields (NOT PII) — read directly by WS-1's engine + RLS.
    timezone     text NOT NULL,                 -- IANA tz; WS-1 fail-closes on unknown
    state        text,                          -- US state code (per-state caps); null = unknown
    consent      boolean NOT NULL DEFAULT false, -- consent-to-contact gate (WS-1)
    opted_out    boolean NOT NULL DEFAULT false, -- do-not-call / opt-out suppression (WS-1)
    opted_out_at timestamptz,
    dispute_open boolean NOT NULL DEFAULT false, -- open dispute PAUSES calling (WS-1 guardrail 9)
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    -- One debtor per (lender, external_ref) → idempotent re-ingestion (upsert).
    UNIQUE (clinic_id, external_ref)
);
CREATE INDEX IF NOT EXISTS debtor_clinic_idx ON debtor (clinic_id);

-- ── debtor RLS ── tenant isolation: a lender sees ONLY its own debtors ───────
-- Same shape as clinic_session_outcome (0018): admin bypass, else clinic_id must
-- match the acting user's app.clinic_id GUC. A different lender's user matches
-- nothing → zero cross-tenant debtor leakage. FORCE so the table owner is bound too.
ALTER TABLE debtor ENABLE ROW LEVEL SECURITY;
ALTER TABLE debtor FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS debtor_scoped ON debtor;
CREATE POLICY debtor_scoped ON debtor FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    );

-- keep updated_at honest on UPDATE (debtor edits: opt-out, dispute, re-ingest).
CREATE OR REPLACE FUNCTION debtor_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS debtor_set_updated_at ON debtor;
CREATE TRIGGER debtor_set_updated_at BEFORE UPDATE ON debtor
    FOR EACH ROW EXECUTE FUNCTION debtor_touch_updated_at();

-- ============================================================================
-- COMPLIANCE AUDIT LEDGER (guardrail 10) — append-only, HMAC hash-chain
-- ----------------------------------------------------------------------------
-- One row per dial decision (ALLOW/BLOCK + reason from WS-1), call outcome, opt-out,
-- and retention purge. Tamper-evidence is three-layered:
--   * content integrity — `integrity` is HMAC-SHA256 (server key) over the row's
--     canonical content (domain/collections-audit).
--   * hash chain — `integrity` also commits to `prev_integrity` (the previous row's
--     tag in the SAME tenant's chain), so deletion/reordering — not just field
--     edits — breaks the next link.
--   * append-only — UPDATE/DELETE revoked from the runtime role AND blocked by a
--     trigger that always raises, so NOT EVEN a tenant admin (who is still the
--     app_rw role with app.is_admin='on') nor the table owner can mutate/erase a
--     logged row. INSERT + SELECT only.
-- `seq` (identity) gives a monotonic, gap-detectable global ordering for review.
-- `refs` holds counts/ids only — NEVER PII content.
-- ============================================================================
CREATE TABLE IF NOT EXISTS collections_audit_log (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq            bigint GENERATED ALWAYS AS IDENTITY,
    ts             timestamptz NOT NULL DEFAULT now(),
    clinic_id      uuid NOT NULL,               -- lender tenant (the chain is per clinic_id)
    actor_user_id  uuid,                         -- authenticated user, when present
    actor_label    text NOT NULL,                -- 'user:<id>' | 'agent:<scenario>' | 'system' | 'system:retention-purge'
    debtor_ref     text NOT NULL,                -- debtor id / external_ref — an identifier, NEVER PII
    event_type     text NOT NULL CHECK (event_type IN ('dial_decision','call_outcome','opt_out','purge')),
    decision       text CHECK (decision IS NULL OR decision IN ('ALLOW','BLOCK')),
    reason         text,                         -- machine-readable reason code (WS-1) / outcome label
    refs           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- counts/ids only — NEVER PII content
    prev_integrity text NOT NULL DEFAULT '',     -- previous row's tag in this tenant's chain ('' = first)
    integrity      text NOT NULL                 -- base64 HMAC over canonical(content) ++ prev_integrity
);
CREATE INDEX IF NOT EXISTS collections_audit_clinic_idx ON collections_audit_log (clinic_id, seq DESC);
CREATE INDEX IF NOT EXISTS collections_audit_debtor_idx ON collections_audit_log (clinic_id, debtor_ref, ts DESC);

-- Append-only at the DB: block UPDATE/DELETE for EVERYONE (incl. owner under FORCE)
-- via a trigger that always raises. Belt-and-braces with the privilege revoke below.
CREATE OR REPLACE FUNCTION collections_audit_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'collections_audit_log is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collections_audit_no_mutate ON collections_audit_log;
CREATE TRIGGER collections_audit_no_mutate
    BEFORE UPDATE OR DELETE ON collections_audit_log
    FOR EACH ROW EXECUTE FUNCTION collections_audit_append_only();

-- RLS: a caller may INSERT log rows and SELECT their own tenant's rows (admins see
-- all, for compliance review). No UPDATE/DELETE policy → none possible.
ALTER TABLE collections_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS collections_audit_insert ON collections_audit_log;
CREATE POLICY collections_audit_insert ON collections_audit_log FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS collections_audit_read ON collections_audit_log;
CREATE POLICY collections_audit_read ON collections_audit_log FOR SELECT USING (
    current_setting('app.is_admin', true) = 'on'
    OR clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
);

-- ── runtime grants ──────────────────────────────────────────────────────────
-- debtor: full DML for the runtime role. collections_audit_log: INSERT/SELECT only
-- (no UPDATE/DELETE/TRUNCATE) so append-only survives even if the trigger were ever
-- dropped. (0007 granted ALL DML by default; tighten the audit table here.)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON debtor TO app_rw;
        REVOKE UPDATE, DELETE, TRUNCATE ON collections_audit_log FROM app_rw;
        GRANT INSERT, SELECT ON collections_audit_log TO app_rw;
    END IF;
END $$;

COMMENT ON TABLE debtor IS
  'Collections (SAU-333): synthetic debtor, lender(clinic)-tenant-scoped RLS. `pii` jsonb is AES-256-GCM at rest (name/phone/balance); operational fields plaintext for WS-1.';
COMMENT ON TABLE collections_audit_log IS
  'Collections compliance ledger (SAU-333, guardrail 10): append-only + per-tenant HMAC hash-chain. Every dial decision/outcome/opt-out/purge. Un-erasable even by tenant admin. refs = counts/ids only, never PII.';
