-- ============================================================================
-- Migration 0008 — Knowledge Base for scenarios (SAU-243, Phase 1)
-- ----------------------------------------------------------------------------
-- A reusable, multi-document corpus that can be linked to MANY scenarios and is
-- folded into the agent's system prompt at session start (bounded by
-- KB_CONTEXT_CHAR_BUDGET; see src/domain/scenario.ts). Distinct from the
-- per-scenario "Additional Context for AI" (single PDF/URL) — KB is upload-once,
-- link-everywhere. Phase 2 (deferred): embeddings/RAG, versioning, sharing
-- beyond owner, OCR.
--
-- Every statement is idempotent (IF NOT EXISTS / DROP+CREATE POLICY) so the
-- forward-only runner is safe on fresh and existing databases.
-- ============================================================================

-- knowledge_base ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_base (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title           text NOT NULL,
    description     text,
    owner_user_id   uuid REFERENCES app_user (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_base_owner_idx ON knowledge_base (owner_user_id);

-- knowledge_base_document -------------------------------------------------------
-- We store only the EXTRACTED TEXT (+ char/byte counts), never the raw upload.
CREATE TABLE IF NOT EXISTS knowledge_base_document (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kb_id           uuid NOT NULL REFERENCES knowledge_base (id) ON DELETE CASCADE,
    filename        text NOT NULL,
    content_type    text NOT NULL CHECK (content_type IN ('pdf', 'docx', 'txt')),
    extracted_text  text NOT NULL DEFAULT '',
    chars           integer NOT NULL DEFAULT 0,
    byte_size       integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
-- (kb_id, created_at) drives the deterministic per-KB injection order.
CREATE INDEX IF NOT EXISTS kb_document_kb_idx ON knowledge_base_document (kb_id, created_at);

-- scenario_knowledge_base (many-to-many join) -----------------------------------
CREATE TABLE IF NOT EXISTS scenario_knowledge_base (
    scenario_id     uuid NOT NULL REFERENCES scenario (id) ON DELETE CASCADE,
    kb_id           uuid NOT NULL REFERENCES knowledge_base (id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scenario_id, kb_id)
);
CREATE INDEX IF NOT EXISTS scenario_kb_kb_idx ON scenario_knowledge_base (kb_id);

-- ── Row-Level Security ─────────────────────────────────────────────────────
-- Posture (SAU-243 Phase 1): WRITES are owner/admin-only at the DB layer
-- (defence-in-depth on top of the API capability gate). READS are intentionally
-- OPEN (USING true): KB text must be readable at session start by ANY learner
-- running a (public) scenario so it can be folded into the system prompt — but
-- raw KB content is NEVER returned to a non-owner by the API (management routes
-- own-scope their lists, and injection text only ever enters the model prompt).
-- Tightening reads to a SECURITY DEFINER injection path is a Phase-2 item,
-- tracked alongside sharing/permissions. No PII by design (authoring reference
-- material), no cross-org in this slice.
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kb_read ON knowledge_base;
CREATE POLICY kb_read ON knowledge_base FOR SELECT USING (true);
DROP POLICY IF EXISTS kb_write ON knowledge_base;
CREATE POLICY kb_write ON knowledge_base FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id IS NULL
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR owner_user_id IS NULL
        OR owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    );

ALTER TABLE knowledge_base_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_document FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kb_doc_read ON knowledge_base_document;
CREATE POLICY kb_doc_read ON knowledge_base_document FOR SELECT USING (true);
DROP POLICY IF EXISTS kb_doc_write ON knowledge_base_document;
CREATE POLICY kb_doc_write ON knowledge_base_document FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM knowledge_base kb WHERE kb.id = kb_id
            AND (kb.owner_user_id IS NULL OR kb.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        )
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM knowledge_base kb WHERE kb.id = kb_id
            AND (kb.owner_user_id IS NULL OR kb.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        )
    );

ALTER TABLE scenario_knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_knowledge_base FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scenario_kb_read ON scenario_knowledge_base;
CREATE POLICY scenario_kb_read ON scenario_knowledge_base FOR SELECT USING (true);
DROP POLICY IF EXISTS scenario_kb_write ON scenario_knowledge_base;
-- Only someone who can write the scenario (its owner/admin) may (un)link KBs.
CREATE POLICY scenario_kb_write ON scenario_knowledge_base FOR ALL
    USING (
        current_setting('app.is_admin', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM scenario s WHERE s.id = scenario_id
            AND (s.owner_user_id IS NULL OR s.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        )
    )
    WITH CHECK (
        current_setting('app.is_admin', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM scenario s WHERE s.id = scenario_id
            AND (s.owner_user_id IS NULL OR s.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
        )
    );

-- The restricted app role (migration 0007) auto-receives table privileges via
-- ALTER DEFAULT PRIVILEGES set there; these tables created by the same migration
-- owner inherit SELECT/INSERT/UPDATE/DELETE with no manual GRANT needed.
