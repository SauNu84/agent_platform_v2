-- ============================================================================
-- Migration 0020 — Booking confirmations + human handoff (SAU-273, Phase 1 · WS3/WS4)
-- ----------------------------------------------------------------------------
-- Closes the loop around a real booking: a delivery log for the patient SMS/email
-- + clinic notifications (WS3), and the escalation/handoff outcome columns (WS4).
--
--   1. clinic_notification — one row per attempted outbound message (patient or
--      clinic). It holds NO PHI: the message bodies are PHI-free by policy
--      (SAU-277) and we store only a MASKED recipient (e.g. '***-***-1234'),
--      never the raw phone/email. Still tenant-scoped via RLS so a clinic only
--      sees its own delivery history.
--
--   2. clinic_session_outcome — three nullable columns recording how an escalated
--      call was handled: escalation_reason, handoff_action, and a confirmation
--      dispatch summary. Expand-contract: all nullable, legacy rows unaffected.
--
-- Idempotent throughout (IF NOT EXISTS / DROP+CREATE POLICY / guarded DO),
-- consistent with the forward-only runner. RLS mirrors the 0018 clinic-scoping.
-- ============================================================================

-- ── confirmation / notification delivery log (no PHI) ────────────────────────
CREATE TABLE IF NOT EXISTS clinic_notification (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      uuid REFERENCES session (id) ON DELETE CASCADE,
    user_id         uuid,                 -- operator who ran the call (owner-read)
    clinic_id       uuid REFERENCES clinic (id) ON DELETE SET NULL,
    reference       text NOT NULL,        -- opaque booking ref (calendar event id)
    channel         text NOT NULL CHECK (channel IN ('sms', 'email')),
    audience        text NOT NULL CHECK (audience IN ('patient', 'clinic')),
    recipient_masked text NOT NULL,       -- masked only — NEVER the raw phone/email
    status          text NOT NULL CHECK (status IN ('sent', 'failed', 'blocked', 'skipped')),
    provider_id     text,                 -- vendor message id (or sim id)
    simulated       boolean NOT NULL DEFAULT true,
    error           text,                 -- short, non-PHI reason on failure/block
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clinic_notification_session_idx ON clinic_notification (session_id);
CREATE INDEX IF NOT EXISTS clinic_notification_clinic_idx  ON clinic_notification (clinic_id, created_at DESC);

-- RLS: admin, the operator who ran the call, or a member of the same clinic.
-- Mirrors clinic_session_outcome (0018). A different clinic's user matches none.
ALTER TABLE clinic_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_notification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clinic_notification_scoped ON clinic_notification;
CREATE POLICY clinic_notification_scoped ON clinic_notification FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
        OR (clinic_id IS NOT NULL AND clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid)
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::uuid
        OR (clinic_id IS NOT NULL AND clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid)
    );

-- ── escalation / confirmation summary on the outcome row (WS4 + WS3) ─────────
ALTER TABLE clinic_session_outcome ADD COLUMN IF NOT EXISTS escalation_reason   text;
ALTER TABLE clinic_session_outcome ADD COLUMN IF NOT EXISTS handoff_action      text;
ALTER TABLE clinic_session_outcome ADD COLUMN IF NOT EXISTS confirmation_status text;

COMMENT ON TABLE clinic_notification IS
  'Booking-confirmation + clinic-notice delivery log (SAU-273). PHI-free: bodies carry no PHI (SAU-277) and only a masked recipient is stored. Tenant-scoped via RLS.';
