-- 0011_developer_tools.sql — SAU-252 (Developer Tools feature)
-- Adds the developer surface that lives under Billing: programmatic access keys
-- and webhook endpoints, both owned per-user. A developer mints an API key to
-- call the platform API and registers webhook endpoints to receive event
-- callbacks (session.completed, analysis.ready, …). The API Reference shown on
-- the same page is static first-party content (services/developer-tools.ts), so
-- it needs no table here.
--
-- Ownership model mirrors the nearest sibling (billing_checkout, 0010): a bare
-- user_id column scoped at the application layer (every query filters by the
-- authenticated actor's userId). No secret material is stored in plaintext —
-- only a one-way hash of the API key plus a short, non-secret display prefix.
--
-- Additive + idempotent (expand-contract): creates new tables only.

-- ── api_key ── one row per minted programmatic key ───────────────────────────
-- The full key (e.g. "ak_live_<random>") is shown to the user EXACTLY ONCE at
-- creation and never persisted; we keep only `key_hash` (SHA-256) for lookup and
-- `key_prefix` (the visible "ak_live_xxxx…" stub) for the list UI. Revocation is
-- a soft delete (revoked_at) so an audit trail of issued keys survives.
CREATE TABLE IF NOT EXISTS api_key (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL,                 -- bare uuid; FK when identity model fully lands
    name         text NOT NULL,                 -- human label, e.g. "Production server"
    key_prefix   text NOT NULL,                 -- non-secret display stub, e.g. "ak_live_8fA2c1"
    key_hash     text NOT NULL UNIQUE,          -- SHA-256 of the full key (the secret never lands here)
    last_used_at timestamptz,                   -- null until first authenticated call
    revoked_at   timestamptz,                   -- null = active; set = revoked (soft delete)
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_user_idx ON api_key (user_id, created_at DESC);

-- ── webhook_endpoint ── one row per registered callback URL ──────────────────
-- `secret` is the signing secret the user copies into their receiver to verify
-- callback authenticity (HMAC of the payload). `events` is the set of event
-- types this endpoint subscribes to.
CREATE TABLE IF NOT EXISTS webhook_endpoint (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL,
    url        text NOT NULL,                    -- https endpoint the platform POSTs to
    secret     text NOT NULL,                    -- signing secret (whsec_…) shown to the user
    events     text[] NOT NULL DEFAULT '{}',     -- subscribed event types
    enabled    boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_endpoint_user_idx ON webhook_endpoint (user_id, created_at DESC);
