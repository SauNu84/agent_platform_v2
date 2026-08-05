-- ============================================================================
-- Migration 0025 — Collections F2 (SAU-356): per-debtor §1692g validation-notice
--                   tracking. Finding F2 from the SAU-353 gate verification.
-- ----------------------------------------------------------------------------
-- The dispute-PAUSE half of §6 #9 was already enforced (debtor.dispute_open →
-- WS-1 `dispute_open` BLOCK). What was missing: per-debtor tracking of the
-- §1692g validation-notice OBLIGATION itself — when the notice was sent, and
-- thus the 30-day dispute window — so the hand-off is evidenced (SAU-330 §6 #9 /
-- §9 Q5), independent of whose contractual job sending it is (counsel: SAU-354).
--
-- ONE nullable column. The 30-day dispute-window END is DERIVED in code
-- (validation_notice_sent_at + 30d), not stored — single source of truth, no
-- drift. Expand-contract + idempotent (IF NOT EXISTS), forward-only runner.
-- No RLS change: debtor's existing lender(clinic)-tenant policy already covers it.
--
-- Renumbered 0024 -> 0025 during the SAU-504 landing: this branch forked at
-- b0a19c6, and main independently took 0024_product_event.sql (SAU-350). The
-- runner sorts by filename, so two 0024s would apply in an ambiguous order.
-- ============================================================================

ALTER TABLE debtor
    ADD COLUMN IF NOT EXISTS validation_notice_sent_at timestamptz;

COMMENT ON COLUMN debtor.validation_notice_sent_at IS
  '§1692g (SAU-356/F2): when the validation notice was sent to this debtor (NULL = not yet sent / unknown). The 30-day dispute window is derived = +30 days; persisted here so the §1692g obligation + dispute state is evidenced per debtor (SAU-330 §6 #9, §9 Q5). Operational/compliance field — NOT PII, stays plaintext for WS-1 + reporting.';
