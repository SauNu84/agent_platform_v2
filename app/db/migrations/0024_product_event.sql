-- ============================================================================
-- Migration 0024 — Product analytics event log (SAU-350, WS5 · parent SAU-345)
-- ----------------------------------------------------------------------------
-- The append-only, PII-FREE product-usage event stream the CMO's funnel /
-- activation / retention read-models project over (services/product-analytics.ts;
-- taxonomy in src/domain/analytics-events.ts).
--
-- This is a THIRD, distinct log alongside two existing ones — and must not be
-- confused with either:
--   * audit_log (0003, ADR-004) — privacy events (memory/consent/DSAR);
--   * phi_access_log (0018, SAU-275) — PHI access for HIPAA §164.312(b).
-- Product events answer "is the UX/journey converting" — they carry NO PHI and
-- NO PII. Same hard posture as audit_log: `props` holds ids/enums/counts ONLY,
-- enforced a second time at the app boundary by assertPiiFree().
--
-- `actor_id` / `tenant_id` are INTERNAL uuids (the same non-PII identifiers
-- audit_log.subject_user_id already stores) — needed for unique-count and
-- week-over-week retention cohorts. They are NOT names/emails/phones.
--
-- Append-only (a trigger blocks UPDATE/DELETE, like collections_audit_log) so the
-- measurement record can't be quietly rewritten. RLS is strictly ADDITIVE (only
-- this NEW table gets a policy); platform rows (tenant_id IS NULL) are visible to
-- all so cross-archetype funnels work; tenant-scoped rows obey app.clinic_id.
-- Expand-contract + idempotent throughout, consistent with the forward-only runner.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_event (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ts           timestamptz NOT NULL DEFAULT now(),
    -- canonical taxonomy name '<archetype>.<noun>.<verb>' (analytics-events.ts).
    event        text NOT NULL,
    -- archetype dimension recovered from the event prefix; CHECK keeps it closed.
    archetype    text NOT NULL CHECK (archetype IN ('platform','clinic','hrm','meeting','collections')),
    -- modality the event originated from, when applicable (web/voice/sms/batch/...).
    surface      text,
    -- INTERNAL non-PII ids for unique/retention cohorts (NOT names/emails/phones).
    actor_id     uuid,
    tenant_id    uuid,            -- owning clinic/org; NULL = platform-wide event.
    session_id   uuid,           -- link to a session, when the event came from one.
    scenario_id  uuid,           -- the agent/template, for per-template funnels.
    -- ids/enums/counts ONLY — NEVER PII/PHI content (assertPiiFree guards writes).
    props        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS product_event_archetype_idx ON product_event (archetype, event, ts DESC);
CREATE INDEX IF NOT EXISTS product_event_actor_idx     ON product_event (actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS product_event_tenant_idx    ON product_event (tenant_id, ts DESC);

-- ── append-only ── block mutation so the measurement record is tamper-evident ─
CREATE OR REPLACE FUNCTION product_event_block_mutate() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product_event is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS product_event_no_mutate ON product_event;
CREATE TRIGGER product_event_no_mutate
    BEFORE UPDATE OR DELETE ON product_event
    FOR EACH ROW EXECUTE FUNCTION product_event_block_mutate();

-- ── RLS ── platform rows visible to all (cross-archetype funnels); tenant rows
-- scoped to app.clinic_id. Admin bypass for the CMO's cross-tenant aggregate read.
ALTER TABLE product_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_event_scoped ON product_event;
CREATE POLICY product_event_scoped ON product_event FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR tenant_id IS NULL
        OR tenant_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR tenant_id IS NULL
        OR tenant_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    );

-- ── runtime grants ──────────────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        -- INSERT + SELECT only; UPDATE/DELETE additionally blocked by the trigger.
        GRANT SELECT, INSERT ON product_event TO app_rw;
    END IF;
END $$;

COMMENT ON TABLE product_event IS
  'Product-analytics event stream (SAU-350, WS5): append-only, PII/PHI-FREE. Powers CMO funnel/activation/retention read-models. props holds ids/enums/counts only.';
