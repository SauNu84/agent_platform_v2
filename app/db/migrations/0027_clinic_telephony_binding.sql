-- ============================================================================
-- Migration 0027 — Clinic telephony binding: dialed number → tenant, per-tenant
--                   voice engine (SAU-525 · SAU-289 seam)
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
-- The telephony bridge answered every inbound call with NO tenant: it read its
-- engine from a global env var (`OPENAI_REALTIME_MODEL`, the premium engine) and
-- created the session with `userId: null`, so the call had no billing principal —
-- no tier, no cap, no `voice_usage` row (CFO finding on SAU-525). The SAU-455 price
-- sheet assumes the Clinic Secretary runs on the mini engine; on the premium path
-- the same tiers deliver 20–35% gross margin against a 70% mandate (SAU-198).
--
-- SHAPE — two nullable columns on the existing `clinic` row; no new tenancy model:
--   • clinic.phone_number — the E.164 number Twilio dials INTO for this tenant
--     (the webhook's `To`). Unique among bound rows, so one number can only ever
--     resolve to one payer. NULL = not reachable by phone (the default; every
--     existing clinic stays unbound and the bridge refuses calls it cannot bill).
--   • clinic.voice_engine — the engine GRADE the tenant's calls run on:
--     'standard' (the cost engine, gpt-realtime-mini by default) or 'premium'.
--     NULL = the archetype default (standard for Clinic Secretary). The concrete
--     model ids stay a config seam in `voice/engine-router` — this column never
--     names a model, so a vendor rename is still a one-line env change.
--   Neither column is PHI or a secret: a clinic's public phone number and a
--   plan-level engine choice. Plaintext, like the rest of the clinic row.
--
-- RLS — no policy change. The 0018/0021 clinic policies stay as they are. The
-- bridge resolves the tenant under a scoped system actor (admin GUC, lookup only)
-- and then runs the call under the clinic OWNER's actor context, so the session /
-- outcome / usage rows are written exactly as if the owner had run it in the UI.
--
-- Expand-only + idempotent (IF NOT EXISTS / guarded constraint), consistent with
-- the forward-only runner. No backfill: an unbound clinic is the safe state.
-- ============================================================================

ALTER TABLE clinic ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE clinic ADD COLUMN IF NOT EXISTS voice_engine text;

-- One dialed number ⇒ one tenant ⇒ one payer. Partial so unbound rows don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS clinic_phone_number_uidx
    ON clinic (phone_number) WHERE phone_number IS NOT NULL;

-- The grade vocabulary is closed; anything else is a bug, not a new tier.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'clinic_voice_engine_chk'
    ) THEN
        ALTER TABLE clinic ADD CONSTRAINT clinic_voice_engine_chk
            CHECK (voice_engine IS NULL OR voice_engine IN ('standard', 'premium'));
    END IF;
END $$;
