-- ============================================================================
-- Migration 0017 — PHI-at-rest encryption posture (SAU-274, Phase 1 · WS5)
-- ----------------------------------------------------------------------------
-- First-class blocker on the HIPAA/PHI go-live gate (SAU-272). Phase 0 (mig 0016,
-- SAU-267) stored clinic intake JSON, call transcripts, and session-event payloads
-- as PLAINTEXT jsonb — acceptable only while every patient was synthetic.
--
-- From this migration on, those PHI-bearing jsonb columns hold an APPLICATION-LAYER
-- AES-256-GCM envelope, not plaintext:
--
--     plaintext  { "name": "Jane Doe", "dob": "1990-01-01", ... }
--     at rest    { "_enc": "<base64 iv>:<base64 ct>:<base64 tag>" }
--
-- Encryption/decryption live at the pg-store boundary (lib/phi.ts → lib/crypto.ts),
-- under the same key as provider secrets (`SETTINGS_ENCRYPTION_KEY`, 32-byte hex;
-- REQUIRED in production — a missing key crashes startup). The matching DATA
-- migration `0017_encrypt_phi` (migrate-encrypt-phi.ts) re-encrypts any plaintext
-- rows left from Phase 0; it is row-level idempotent.
--
-- PHI columns covered (no DDL change — the columns stay jsonb, now holding the
-- envelope object):
--   * clinic_session_outcome.intake   — patient name / DOB / reason / insurance
--   * session.transcript              — full call transcript
--   * session_event.payload           — live transcript + tool-call payloads
--
-- NOT encrypted here (operational metadata / non-identifying, and queried directly):
--   booking outcome columns event_id/event_link/doctor_*/slot_*/calendar. Patient
--   identity lives in `intake` (encrypted). Linkage of a patient to a booking is
--   further protected by row-level access control + managed-Postgres at-rest disk
--   encryption (see docs/SAU-274-phi-encryption-at-rest.md, feeds the BAA item).
--
-- This file is a documentation/marker migration so the posture change is recorded
-- in `schema_migrations` alongside the code; the re-encryption work is the data
-- migration above. Coordinated ciphertext format with CISO (SAU-272/276).
-- ============================================================================

COMMENT ON COLUMN clinic_session_outcome.intake IS
  'PHI (SAU-274): AES-256-GCM envelope { _enc: "iv:ct:tag" } at rest; decrypted only in-process. Never store plaintext patient data here.';

COMMENT ON COLUMN session.transcript IS
  'PHI (SAU-274): AES-256-GCM envelope { _enc: "iv:ct:tag" } at rest; decrypted only in-process. Never store plaintext transcript here.';

COMMENT ON COLUMN session_event.payload IS
  'PHI (SAU-274): AES-256-GCM envelope { _enc: "iv:ct:tag" } at rest; decrypted only in-process. Never store plaintext payload here.';
