-- 0012_settings.sql — SAU-253 (Settings menu)
-- Backs the new Settings hub (under Billing in the left nav). Most Settings tabs
-- reuse existing tables: Account → app_user + user_entitlement; Memory →
-- coach_memory (ADR-004); Knowledge Bases → knowledge_base (0008). The remaining
-- preference-style tabs — Language, My Voice, Integrations — share one generic
-- per-user key/value table rather than a column-per-feature, so new preference
-- surfaces can land without a schema change each time.
--
-- Ownership model mirrors the nearest siblings (billing_checkout 0010, api_key
-- 0011): a bare user_id scoped at the application layer (every query filters by
-- the authenticated actor's userId). No secret/PII content is stored — values
-- are small JSON config blobs (selected language, voice-profile label + status,
-- integration connection settings).
--
-- Additive + idempotent (expand-contract): creates a new table only.

-- ── user_setting ── one row per (user, setting key) ──────────────────────────
-- key examples:
--   'preferred_language'   → {"lang":"en"}
--   'voice_profile'        → {"name":"My voice","status":"pending"}
--   'integration:phone'    → {"status":"configured","sipTrunkUri":"sip:…"}
--   'integration:calendar' → {"status":"configured","provider":"google"}
--   'integration:mcp'      → {"status":"configured","tools":["gmail","gcal"]}
CREATE TABLE IF NOT EXISTS user_setting (
    user_id    uuid NOT NULL,                 -- bare uuid; FK when identity model fully lands
    key        text NOT NULL,                 -- setting key (see examples above)
    value      jsonb NOT NULL DEFAULT '{}',    -- small JSON config blob (no secrets/PII)
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS user_setting_user_idx ON user_setting (user_id);
