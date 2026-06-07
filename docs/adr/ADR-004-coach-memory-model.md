# ADR-004 — Coach memory model (storage, retrieval, retention, user controls)

- **Status:** **Accepted** — CISO confirmation pass complete 2026-06-06 (SAU-178): all 7 **MUST** conditions verified folded into this ADR, the ERD, and the ADR-003 privacy gate; CISO privacy sign-off is now **final/unconditional**. See [ADR-004 CISO Privacy Review](ADR-004-CISO-privacy-review.md) and issues SAU-177 (review) / SAU-178 (confirmation).
- **Date:** 2026-06-06 (revised 2026-06-06 to fold in CISO sign-off conditions)
- **Author:** Enterprise Architect
- **Deciders:** CTO (ratify), CISO (privacy/compliance sign-off — **confirmed 2026-06-06, SAU-178**), CPO (UX of user controls)
- **Parent:** SAU-171 · **Issue:** SAU-175 · **Privacy review:** SAU-177
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §4, §7, §9 (Memory privacy risk)
- **Related:** [ADR-001](ADR-001-scenario-as-core-primitive.md) (Coach = Scenario + memory + schedule), [ADR-003](ADR-003-realtime-voice-build-vs-buy.md) (realtime vendor privacy gate), [ADR-004 CISO Privacy Review](ADR-004-CISO-privacy-review.md) (signed conditions)

## Context

Coaches "**remember every conversation**" (verified reference behavior). This is the feature that differentiates a Coach from a one-off Scenario — and it is **PII and a compliance surface** (design §9, ranked a top risk). We must define storage, retrieval, retention, and user controls *before* building Coach (Slice 3), and gate it on CISO review because the privacy decisions here are not the architect's to make unilaterally.

Memory is **per-user, per-coach**: the Pitch Coach's memory of user A is invisible to user B and to other coaches.

> **Legal note (from the CISO review):** this ADR encodes a security/privacy *engineering* posture, not legal advice. The legal-basis and retention positions are defensible defaults and must be confirmed by counsel (DPIA sign-off) before launch.

## Decision

### Storage
- **Postgres** for memory records; **pgvector** for semantic retrieval embeddings (design §7 — no new datastore at MVP; split out only if scale demands). Table `coach_memory` (see ERD): `id, coach_id, user_id, kind, content, embedding, source_session_id, salience, created_at, expires_at`.
- **`kind`** taxonomy: `summary` (rolling per-session synthesis), `fact` (durable user attribute the user stated, e.g. "preparing for a Series A pitch"), `preference` (interaction style), `goal/commitment` (action items from Analyst). We store **derived summaries and facts, not raw transcripts**, in the memory store — raw transcripts live with the Session and follow Session retention.
- **Tenancy isolation:** every query is scoped by `(coach_id, user_id)`; **Postgres RLS is mandated** on `coach_memory` as the defense-in-depth backstop (see *Tenancy & RLS* below). Index `(coach_id, user_id, created_at)` and an ANN index on `embedding`.

### Tenancy & RLS (mandated — resolves CISO open item #2)
- **App-layer `(coach_id, user_id)` scoping is the primary control; RLS is the mandated backstop.** Cross-user memory leakage (user A sees what the coach "remembers" about user B) is the single worst outcome for this product; for a table where one missing `WHERE user_id = …` equals a cross-tenant PII breach, a database-level guarantee is the highest-leverage control available.
- **Implementation:** request-scoped `SET LOCAL app.user_id = <authenticated uuid>` inside the transaction, with RLS policy `USING (user_id = current_setting('app.user_id')::uuid)`. User-facing queries run under a role **subject to** the policy (never a bypass/superuser role).
- **Exception path (high bar):** if connection-pooling posture (e.g. a transaction-mode pooler that breaks `SET LOCAL`) makes per-request RLS genuinely infeasible, waiving RLS requires **CISO + CTO joint sign-off** AND all of these compensating controls (each a MUST if RLS is waived): (a) a single tenancy-enforcing data-access module — no ad-hoc raw queries to `coach_memory`; (b) a CI lint/test gate that **fails the build** on any out-of-module query to `coach_memory`; (c) a scheduled **cross-tenant canary** in prod asserting user A can never read user B's memory. RLS is expected to be adopted.
- **SHOULD (recommended, not gating):** extend RLS to the other per-user PII tables — `session`, `session_event`, `analysis`.

### Retrieval
- At session start and on demand mid-session: retrieve top-K memories for `(coach_id, user_id)` by **hybrid** recency + semantic similarity + `salience`, inject into the agent context as a compact "what you remember about this user" block. Bound the injected token budget (cost + privacy minimization).
- **Retrieval is an audited event** (see *Audit logging*): log who/when/which coach/how-many records — **never the memory content**.

### Retention & legal basis (resolves CISO open item #1)

PII is tiered by sensitivity; retention follows the tier. **Audio is the most sensitive** (voice is biometric-*adjacent* — see *Boundaries*) and carries the shortest default and its own consent toggle.

| Data class | Store | Default retention | Max (user opt-in) | Legal basis (GDPR Art. 6) |
|---|---|---|---|---|
| **Raw audio recordings** | object store (`recording_uri`) | **30 days**, then hard-delete | 90 days | **Consent** (6(1)(a)) — separately-toggled opt-in |
| **Raw transcripts** | object store (`transcript_uri`) | **90 days** | 365 days | **Contract** (6(1)(b)) for the active session + analysis; **consent** to retain beyond |
| **Session summaries** (`kind=summary`) | `coach_memory` | **365 days** rolling | 365 days | **Consent** (6(1)(a)) — persistent memory is the opt-in differentiator |
| **Facts / preferences / goals** (`kind=fact\|preference\|goal`) | `coach_memory` | **persistent while consent active**, with a **24-month dormancy expiry** | n/a | **Consent** (6(1)(a)) |

Retention rules (all MUST):
- **Summaries 365d** (revised down from the original 400d proposal — cleaner annual audit boundary, defensible under data-minimisation, preserves longitudinal-coaching value).
- **"Persistent" is not "forever":** facts/preferences/goals auto-expire via `expires_at` if **not retrieved or reinforced within 24 months** (dormancy backstop — caps unbounded accumulation).
- **Legal basis = consent for the persistent layer + audio retention; contract for the live session.** We do **not** rely on legitimate interest for persistent memory — consent makes revocation unambiguous and is the legal anchor of the feature.
- **`expires_at` is set at write time** for every row (summaries: `created_at + 365d`; facts/etc.: `created_at + 24mo`, **bumped on each retrieval/reinforcement**). **Object-store lifecycle rules** on the transcript/recording buckets **mirror** these windows — expiry is enforced by the store/server-side purge job, never only in UI.
- **Account deletion cascades** to all of the above within the DSAR erasure SLA, regardless of per-class window.

### User controls — consent & DSAR (privacy by design — resolves CISO open item #3)
- **View** everything a coach remembers (memory inspector).
- **Delete** individual memories or **wipe all memory** for a coach (right-to-erasure; cascades to embeddings + derived rows; logged).
- **Pause memory** ("don't remember this session") — session runs ephemeral, **no memory written**; always available regardless of consent toggles.
- **Export** memory (machine-readable JSON; data portability; self-service).
- **Consent gate at first Coach use**, *before* any memory row is written — **not pre-ticked**, **not bundled** into general ToS/privacy acceptance (GDPR Art. 7 specificity). **Granular, independently-controllable toggles:**
  - (a) **Persistent memory** — store summaries + facts/preferences/goals across sessions.
  - (b) **Audio recording retention** — keep the raw recording past the session.
- Plain-language disclosure at the gate covers *what* is stored, *why*, *how long* (the windows above), that memory is **per-coach and never shared**, and *how to view/export/delete/revoke*. Draft copy:

  > **Let this coach remember you?**
  > To pick up where you left off, [Coach] can remember a summary of your sessions and key facts you share (e.g. goals, preferences) — **only for this coach, never shared with other users or coaches.** Summaries are kept up to 12 months; facts until you delete them or 24 months of inactivity. You can view, export, or delete everything any time in *Memory settings*, and turn this off whenever you like.
  > ☐ Remember my sessions with this coach   ☐ Also keep my audio recordings (up to 90 days)

- **Record-of-consent (MUST) — new `consent_record` entity** (see ERD), **append-only**: a revocation is a new row, never an update-in-place, so consent state is reconstructable at any past timestamp. Captures `user_id`, `scope` (`coach:<id>`|`global`), `consent_type` (`persistent_memory`|`audio_retention`), `action` (`granted`|`revoked`), `policy_version`, **`policy_text_hash`** (proves the exact wording agreed to), `locale`/`ui_surface`, `source_ip`, `user_agent`, `created_at`.
- **Consent proof outlives the data:** retain `consent_record` for **processing duration + 6 years** (limitation period) even after the underlying memory is erased.
- **Revocation behaviour:** revoking (a) immediately stops new writes and **offers erasure of existing consent-based memory** (default = wipe; user may explicitly choose "stop but keep"). Revoking (b) stops retaining new recordings and purges retained ones on the erasure SLA.

### DSAR SLA + audit logging (resolves CISO open item #5)
- **DSAR (access/export/erasure/rectification):** **acknowledge ≤ 72h; fulfil ≤ 30 calendar days** (GDPR Art. 12; covers CCPA 45d). Self-service View/Export/Delete is effectively immediate; the 30-day clock is the manual/escalated backstop (internal target 14d).
- **Erasure scope & SLA:** in-app "wipe memory" = immediate logical delete + **hard purge within 7 days** across **all** of: `coach_memory` rows, their **embeddings**, derived rows, linked transcripts/recordings under consent-based retention, **and** a vendor-side deletion request where the realtime vendor retained anything.
- **Backups:** erased data is purged from backups on the **backup rotation cycle** — documented honestly as "within 35 days of the erasure request" (no claim of instant backup deletion).
- **Erasure verification:** automated post-purge check asserting **zero residual rows** for the user, recorded against the DSAR.
- **Audit logging (MUST):** log every privacy-relevant event — memory **write**, **retrieval into agent context** (counts/refs, not content), **delete/wipe**, **consent grant/revoke**, **export**, every **DSAR action**, and **all staff/admin access** to a user's memory/transcripts/recordings. Staff access is **break-glass** (generates an alert), never silent.
- **Log hygiene:** audit logs are **append-only / tamper-evident**, access-restricted, **contain no PII content** (IDs and references only), retained **≥ 18 months**, and **feed anomaly alerts** (bulk reads, cross-tenant patterns, retrieval spikes).

### Realtime-vendor data flow (resolves CISO open item #4 — gate lives in ADR-003)
The realtime vendor is still TBD ([ADR-003](ADR-003-realtime-voice-build-vs-buy.md), blocked on the Slice-0 measured spike). Per the CISO review, a **privacy/data-protection gate any candidate MUST clear** is now a **scored rubric row + scorecard section in ADR-003**: signed DPA (Art. 28) + SCCs/UK IDTA; **no-training-on-our-data (hard gate)**; zero/minimal vendor retention; data-residency pinning; sub-processor disclosure + flow-down; SOC 2 Type II / ISO 27001 + ≤72h breach SLA. The spike may run on **synthetic/seed audio only** — no real user PII to an un-DPA'd vendor. A self-hosted cascade (LiveKit/Pipecat) is a genuine privacy advantage and is weighted as such in the ADR-003 rubric.

### Boundaries
- Memory is **never** shared across users or coaches. No cross-user training/aggregation of memory content without a separate, explicit ADR + CISO + legal review.
- **No voiceprint / speaker-identification / voice-biometric features** on recordings or audio without a **new ADR + CISO + legal review.** Today we process voice to *converse*, not to *identify a person* — so it is not biometric special-category data. The moment audio is used to identify/authenticate a person it becomes biometric data triggering GDPR Art. 9 and US state laws with private rights of action (Illinois **BIPA**, Texas CUBI, Washington). This is a deliberate, separately-governed decision.

## Consequences

**Positive:** reuses the existing Postgres + PII tooling (design §7) — no new datastore. Storing derived summaries (not raw transcripts) in the memory store minimizes the PII blast radius and the injected-context cost. RLS makes cross-tenant leakage structurally impossible, not just policy-prevented. Consent-as-legal-basis + append-only `consent_record` makes revocation and erasure clean and auditable. User controls are first-class, satisfying erasure/portability obligations by construction.

**Negative / trade-offs:** pgvector at high scale may need a dedicated vector store later (explicit revisit trigger: retrieval p95 latency or index size). Summarization is lossy and could drop a detail the user expects remembered — mitigate with the `fact` kind for user-asserted durable items. Hybrid retrieval tuning (recency vs similarity vs salience weights) needs evaluation data. RLS plus a transaction-mode pooler requires care (`SET LOCAL` semantics); the documented exception path exists for that case but raises the operational bar.

## Status of CISO open items (all resolved)
1. Retention windows + legal basis — **resolved** (Retention table above; consent for persistent layer, contract for live session).
2. RLS vs app-layer — **resolved** (RLS mandated on `coach_memory`; exception path with compensating controls).
3. Consent UX + record-of-consent — **resolved** (granular non-pre-ticked toggles + `consent_record` entity, 6-year proof retention).
4. Realtime-vendor constraints — **resolved** (privacy gate added to ADR-003 rubric; synthetic-audio-only spike).
5. DSAR SLA + audit logging — **resolved** (ack 72h / fulfil 30d / hard-purge 7d / backups ≤35d; comprehensive audit logging).

## Alternatives considered

1. **Store raw transcripts as memory and retrieve over them directly.** Rejected — larger PII surface, higher injected-context cost, harder erasure. Derived-summary store is leaner and safer.
2. **Dedicated vector DB (Pinecone/Weaviate) from day one.** Rejected for MVP — new vendor/datastore against the "reuse what we run" stance; pgvector is sufficient until measured otherwise.
3. **App-layer tenancy scoping only (no RLS).** Rejected — one missing `WHERE` is a cross-tenant PII breach; RLS makes that bug class structurally impossible. Permitted only via the documented high-bar exception path.
4. **Legitimate interest as the legal basis for persistent memory.** Rejected — consent matches the granular/revocable UX and makes revocation unambiguous.
