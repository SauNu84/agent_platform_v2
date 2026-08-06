-- ============================================================================
-- Migration 0026 — Collections: per-tenant (per-lender) policy persistence
--                   (SAU-521 · SAU-331 gate item 2)
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- `TenantCollectionsConfig` (domain/collections-engine) was an enforcement SEAM with
-- no way to supply a value: no table, no column, no route. `allowedStates` — the state
-- licensing allow-list — therefore could never be set in production, and the engine
-- treated an absent list as "gate off". SAU-521 makes the engine fail closed on an
-- unconfigured allow-list; this migration gives operators the means to configure it,
-- which is the other half of that change. Without both, a fail-closed engine would
-- simply block every tenant forever.
--
-- SHAPE — deliberately the same primitives as 0022, not a new tenancy model:
--   • Tenant = the existing `clinic` row (a clinic REPRESENTS A LENDER here), scoped by
--     the SAME `app.clinic_id` RLS GUC as `debtor`. One policy per lender: clinic_id is
--     the PRIMARY KEY, so the row IS the tenant's policy (no versioning, no soft rows).
--   • RLS shape is copied verbatim from `debtor_scoped` (0022). This is additive only:
--     no existing table, policy or grant is modified, so `debtor`'s tenant isolation is
--     untouched.
--   • Nothing here is PII or a secret — these are the tenant's own operating limits
--     (which states it is licensed in, and any stricter per-state call caps), so the
--     columns are plaintext. The AES-256-GCM envelope is not needed and would only make
--     the values unreadable to a compliance reviewer.
--
-- SHIPS EMPTY, ON PURPOSE. No default row is created and no state list is seeded. Which
-- states we are actually licensed to collect in is counsel's call (SAU-354 §9 Q3), NOT
-- an engineering guess. Under SAU-521 an absent row means every dial is BLOCKED with
-- `licensing_unconfigured` — the safe direction — so the empty state is correct, not a
-- gap to be filled in with plausible values.
-- ============================================================================

-- ── collections_policy ── one row per lender(clinic) tenant ─────────────────
CREATE TABLE IF NOT EXISTS collections_policy (
    clinic_id     uuid PRIMARY KEY REFERENCES clinic (id) ON DELETE CASCADE,  -- the lender tenant
    -- State licensing allow-list (§4 / §8 item 2): 2-letter USPS codes, uppercase.
    -- EMPTY ARRAY = not configured = every dial blocked `licensing_unconfigured`.
    -- It is NOT "licensed nowhere and therefore fine"; it is "not cleared to dial".
    allowed_states  text[] NOT NULL DEFAULT '{}'::text[],
    -- Per-state STRICTER-ONLY frequency caps, keyed by 2-letter state code:
    --   { "MA": { "maxCalls": 2, "perDays": 7 }, ... }
    -- Applied IN ADDITION to the hard-constant federal Reg-F 7-in-7, which is not
    -- reachable from config and fires beneath this whether or not it is set. That floor
    -- is why `state_caps` is safe to leave unconfigured and `allowed_states` is not.
    state_caps      jsonb  NOT NULL DEFAULT '{}'::jsonb,
    -- Who last changed the policy, for the compliance trail. NOT a foreign key: the
    -- editing user may be deleted long before the policy is (retention asymmetry).
    updated_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Guard the invariants the loader relies on, at the storage layer, so a hand-written
-- UPDATE cannot install a policy shape the engine would misread:
--   • every allow-list entry is exactly two uppercase letters (no lowercase 'ca', no
--     'California', no empty string that would silently match nothing);
--   • state_caps is an object, not an array/scalar.
-- A CHECK cannot contain a subquery, so the per-element test lives in an IMMUTABLE
-- helper. `bool_and` over an empty array yields NULL, and `IS NOT FALSE` maps that to
-- true — an empty allow-list is a VALID value (it is the not-configured state the engine
-- blocks on), it is not malformed.
CREATE OR REPLACE FUNCTION collections_policy_states_valid(states text[]) RETURNS boolean AS $$
    SELECT bool_and(s ~ '^[A-Z]{2}$') IS NOT FALSE
    FROM unnest(coalesce(states, '{}'::text[])) AS s;
$$ LANGUAGE sql IMMUTABLE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collections_policy_states_shape') THEN
        ALTER TABLE collections_policy ADD CONSTRAINT collections_policy_states_shape
            CHECK (collections_policy_states_valid(allowed_states));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collections_policy_caps_object') THEN
        ALTER TABLE collections_policy ADD CONSTRAINT collections_policy_caps_object
            CHECK (jsonb_typeof(state_caps) = 'object');
    END IF;
END $$;

-- ── RLS ── same shape as debtor_scoped (0022): admin bypass, else the acting
-- user's app.clinic_id GUC must match. FORCE so the table owner is bound too.
-- A different lender's user matches nothing → no cross-tenant policy read OR write.
ALTER TABLE collections_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS collections_policy_scoped ON collections_policy;
CREATE POLICY collections_policy_scoped ON collections_policy FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid
    );

-- keep updated_at honest on UPDATE (policy edits are the audit-relevant event).
CREATE OR REPLACE FUNCTION collections_policy_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collections_policy_set_updated_at ON collections_policy;
CREATE TRIGGER collections_policy_set_updated_at BEFORE UPDATE ON collections_policy
    FOR EACH ROW EXECUTE FUNCTION collections_policy_touch_updated_at();

-- ── runtime grants ──────────────────────────────────────────────────────────
-- (0007 ALTER DEFAULT PRIVILEGES already covers new tables; re-granted explicitly,
-- consistent with 0022.)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON collections_policy TO app_rw;
    END IF;
END $$;

COMMENT ON TABLE collections_policy IS
  'Collections per-lender policy (SAU-521): state licensing allow-list + stricter-only per-state caps, clinic(lender)-tenant-scoped RLS. Ships EMPTY — an absent row or empty allowed_states means every dial is BLOCKED licensing_unconfigured. Licensed-state VALUES are counsel''s call (SAU-354 §9 Q3), never an engineering guess.';
COMMENT ON COLUMN collections_policy.allowed_states IS
  'USPS 2-letter codes this lender is licensed to collect in. EMPTY = not configured = fail closed (not "no restriction").';
COMMENT ON COLUMN collections_policy.state_caps IS
  'Stricter-only per-state caps { "XX": { "maxCalls": n, "perDays": n } }. The federal Reg-F 7-in-7 hard constant fires beneath this regardless.';
