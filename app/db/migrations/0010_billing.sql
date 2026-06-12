-- 0010_billing.sql — SAU-250 (Billing feature)
-- Adds the billing surface: a named subscription tier on the existing entitlement
-- row, plus a `billing_checkout` record that tracks a user's intent to subscribe
-- (the hand-off to the external payment provider — Stripe / DodoPayments).
--
-- Why a checkout table: the plan-selection modal sends the user to a hosted
-- provider page; we persist a pending checkout BEFORE the redirect so the
-- provider's return/webhook can be matched back to (user, plan) and the
-- entitlement upgraded idempotently. The provider call itself lives behind a
-- service seam (services/billing/checkout-provider.ts) — no secrets here.
--
-- Additive + idempotent (expand-contract): no existing column is altered.

-- ── plan_tier ── the named subscription tier shown on the Billing page ────────
-- `plan` (free|paid) still drives the meter cap; `plan_tier` records WHICH paid
-- tier so the UI can render "Standard" / "Premium" and the right allowance.
ALTER TABLE user_entitlement
    ADD COLUMN IF NOT EXISTS plan_tier text NOT NULL DEFAULT 'free'
        CHECK (plan_tier IN ('free', 'standard', 'premium'));

-- ── billing_checkout ── one row per checkout intent (provider hand-off) ───────
-- status: pending  → created, user sent to the provider's hosted page
--         completed → provider confirmed payment; entitlement upgraded
--         canceled  → user backed out of the provider page
CREATE TABLE IF NOT EXISTS billing_checkout (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL,                 -- bare uuid; FK when identity model fully lands
    plan_id       text NOT NULL,                 -- 'standard' | 'premium' (catalog id)
    billing_cycle text NOT NULL DEFAULT 'monthly'
                      CHECK (billing_cycle IN ('monthly', 'annual')),
    provider      text NOT NULL,                 -- 'mock' | 'stripe' | 'dodo'
    amount_cents  integer NOT NULL DEFAULT 0,    -- charged amount (placeholder pricing OK)
    status        text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'canceled')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_checkout_user_idx
    ON billing_checkout (user_id, created_at DESC);
