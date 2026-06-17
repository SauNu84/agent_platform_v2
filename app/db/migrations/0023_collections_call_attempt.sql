-- ============================================================================
-- Migration 0023 — Collections: per-attempt OUTCOME model (SAU-335, WS-4 ·
--                   parent SAU-328)
-- ----------------------------------------------------------------------------
-- The per-debtor / per-call-attempt outcome store that the per-tenant ops
-- dashboard aggregates. SCOPE: SYNTHETIC debtors only — nothing here places a
-- real call.
--
-- Like the clinic outcome model (clinic_session_outcome, migration 0016/0018),
-- this REUSES the proven multi-tenant primitive: the lender is the existing
-- `clinic` row and rows are scoped by the SAME `app.clinic_id` RLS GUC that
-- 0018/0021/0022 established. A debtor's attempts are FK'd to the debtor row
-- (migration 0022) so they cascade-delete on retention purge.
--
-- One row per attempt records the disposition (CollectionsOutcome) +
-- `had_conversation` (the Reg-F cooldown fact WS-1's engine reads back) +
-- `block_reason` (the WS-1 code when the dialer was refused). The append-only,
-- tamper-evident COMPLIANCE record of each decision/outcome still lives in
-- `collections_audit_log` (guardrail 10, 0022); this table is the queryable
-- OPERATIONAL projection for the dashboard + the frequency-gate history.
--
-- RLS is strictly ADDITIVE (only this NEW table gets a policy); expand-contract +
-- idempotent throughout, consistent with the forward-only runner. The 0007 ALTER
-- DEFAULT PRIVILEGES grant covers it; we re-grant explicitly too.
-- ============================================================================

CREATE TABLE IF NOT EXISTS collections_call_attempt (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id        uuid NOT NULL REFERENCES clinic (id) ON DELETE CASCADE, -- the lender tenant
    debtor_id        uuid NOT NULL REFERENCES debtor (id) ON DELETE CASCADE, -- cascades on purge
    outcome          text NOT NULL CHECK (outcome IN (
                         'contacted','promised_to_pay','no_answer','voicemail_left',
                         'opted_out','dispute_raised','blocked_by_compliance')),
    -- live conversation about the debt occurred? — the fact WS-1's Reg-F cooldown reads.
    had_conversation boolean NOT NULL DEFAULT false,
    -- WS-1 block reason code when outcome = 'blocked_by_compliance' (no call placed), else null.
    block_reason     text,
    attempted_at     timestamptz NOT NULL DEFAULT now(),
    simulated        boolean NOT NULL DEFAULT true,           -- synthetic POC marker
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collections_attempt_debtor_idx
    ON collections_call_attempt (clinic_id, debtor_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS collections_attempt_clinic_idx
    ON collections_call_attempt (clinic_id, attempted_at DESC);

-- ── RLS ── tenant isolation: a lender sees ONLY its own attempts ─────────────
-- Same shape as debtor (0022) / clinic_session_outcome (0018): admin bypass, else
-- clinic_id must match the acting user's app.clinic_id GUC. A different lender's
-- user matches nothing → zero cross-tenant leakage. FORCE so the owner is bound too.
ALTER TABLE collections_call_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_call_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS collections_attempt_scoped ON collections_call_attempt;
CREATE POLICY collections_attempt_scoped ON collections_call_attempt FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    );

-- ── runtime grants ──────────────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON collections_call_attempt TO app_rw;
    END IF;
END $$;

COMMENT ON TABLE collections_call_attempt IS
  'Collections outcome model (SAU-335, WS-4): one row per call attempt, lender(clinic)-tenant-scoped RLS. Operational projection of outcomes; the tamper-evident compliance record stays in collections_audit_log.';
