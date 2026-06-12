-- 0013_voice_tier_engine — per-tier voice metering (SAU-256, Phase 1 HYBRID router)
--
-- The tiered voice model router (SAU-255 build-vs-buy) routes free-tier users to a
-- cheaper engine and paid tiers to the "Super" engine. To observe the realized
-- blended cost cut by tier, voice_usage records WHICH tier a session ran at and
-- WHICH engine model the router selected — alongside the existing server-reported
-- `model` (rate attribution) and measured token counts.
--
-- Forward-only + idempotent (re-runnable). Existing rows keep NULL tier/engine
-- (they predate the router); the per-tier aggregate groups them under (∅, ∅).

ALTER TABLE voice_usage ADD COLUMN IF NOT EXISTS tier   text;  -- 'free' | 'paid'
ALTER TABLE voice_usage ADD COLUMN IF NOT EXISTS engine text;  -- config-driven engine model id

CREATE INDEX IF NOT EXISTS voice_usage_tier_idx ON voice_usage (tier, engine);
