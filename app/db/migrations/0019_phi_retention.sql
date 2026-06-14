-- ============================================================================
-- Migration 0019 — PHI retention: per-clinic windows + purge audit action (SAU-285)
-- ----------------------------------------------------------------------------
-- Phase 1 · WS5. First-class blocker on the HIPAA/PHI go-live gate (SAU-272),
-- gate item 11. The retention/disposal POLICY is approved (program doc §4); this
-- adds the two schema affordances the automatic purge needs:
--
--   1. PER-CLINIC RETENTION OVERRIDES. The disposal windows are config-driven
--      (env defaults: transcripts/audio 30d, intake+booking 1y, phi_access_log 6y)
--      but each clinic BAA may negotiate its own. `clinic.retention` is an optional
--      jsonb override read by the purge ({ "transcriptDays": N, "intakeDays": M });
--      NULL → platform defaults. No PHI here — just integers.
--
--   2. A 'purge' ACTION on the append-only PHI audit log. The retention purge must
--      record its own destructive disposal in the same tamper-evident trail
--      (§164.316(b)(2) accountability). The 0018 CHECK allowed only read/write;
--      widen it to include 'purge' so disposal is first-class and queryable.
--
-- NOTE: the purge NEVER deletes phi_access_log rows — that table is append-only by
-- privilege + trigger (0018) and retained 6y. Purging PHI is crypto-shred: where
-- a column is encrypted at rest (SAU-274), nulling/deleting the row destroys the
-- only ciphertext; backups age out within the same window (documented in the
-- program doc / delivery note). Idempotent throughout.
-- ============================================================================

-- ── per-clinic retention overrides ──────────────────────────────────────────
ALTER TABLE clinic ADD COLUMN IF NOT EXISTS retention jsonb;
COMMENT ON COLUMN clinic.retention IS
  'Per-clinic PHI retention overrides (SAU-285): {"transcriptDays":N,"intakeDays":M}. '
  'NULL → platform defaults (env: PHI_RETENTION_TRANSCRIPT_DAYS=30 / PHI_RETENTION_INTAKE_DAYS=365). Integers only — never PHI.';

-- ── allow 'purge' in the append-only PHI audit log ──────────────────────────
-- The inline 0018 CHECK is auto-named <table>_<column>_check. Drop + re-add to
-- widen the allowed actions; this touches a constraint, not data, and the
-- append-only trigger/privileges are unaffected.
ALTER TABLE phi_access_log DROP CONSTRAINT IF EXISTS phi_access_log_action_check;
ALTER TABLE phi_access_log ADD CONSTRAINT phi_access_log_action_check
    CHECK (action IN ('read', 'write', 'purge'));
