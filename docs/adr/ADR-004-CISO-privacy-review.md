# ADR-004 — CISO Privacy-Surface Review & Sign-off (Coach memory model)

- **Status:** **Approved — confirmation pass complete (sign-off final).** Conditional sign-off issued 2026-06-06 (SAU-177); **CISO confirmation pass 2026-06-06 (SAU-178) verified all 7 MUST conditions folded into ADR-004, the ERD, and the ADR-003 privacy gate → ADR-004 is now Accepted.** The **SHOULD** items remain recommendations, not gates. See the *Confirmation pass* section at the end of this doc.
- **Reviewer:** CISO
- **Date:** 2026-06-06
- **Gates:** [ADR-004](ADR-004-coach-memory-model.md) (Proposed → Accepted) · **Issue:** SAU-177 (child of SAU-175)
- **Inputs reviewed:** `ADR-004-coach-memory-model.md`, `ADR-003-realtime-voice-build-vs-buy.md`, `architecture/ERD.md`, `SAU-171-brandstorm-architecture.md` §7/§9, `spikes/slice-0-realtime-voice/RESULTS.md` (vendor still TBD).
- **Legal note:** This is a security/privacy engineering review, not legal advice. The legal-basis and retention positions below should be confirmed by counsel before launch; they are defensible defaults, not a substitute for a DPIA sign-off.

The model is fundamentally sound: per-(coach,user) isolation, derived-summaries-not-raw-transcripts, server-enforced expiry, and first-class user controls are the right spine. The conditions below tighten the highest-leverage surfaces (cross-tenant leakage, retention defensibility, consent provenance, vendor data flow) without redesigning it.

---

## 1. Retention windows + legal basis (resolves open item #1)

PII is tiered by sensitivity; retention follows the tier. **Audio is the most sensitive** (a voice recording is biometric-*adjacent* — see §6) so it gets the shortest default.

| Data class | Store | Default retention | Max (user opt-in) | Legal basis (GDPR Art. 6) |
|---|---|---|---|---|
| **Raw audio recordings** | object store (`recording_uri`) | **30 days**, then hard-delete | 90 days | **Consent** (6(1)(a)) — recording retention is an explicit, separately-toggled opt-in |
| **Raw transcripts** | object store (`transcript_uri`) | **90 days** | 365 days | **Contract** (6(1)(b)) for the active session + analysis; **consent** to retain beyond the analysis window |
| **Session summaries** (`kind=summary`) | `coach_memory` | **365 days** rolling | 365 days | **Consent** (6(1)(a)) — persistent memory is the opt-in differentiator |
| **Facts / preferences / goals** (`kind=fact\|preference\|goal`) | `coach_memory` | **persistent while consent active**, with a **24-month dormancy expiry** | n/a | **Consent** (6(1)(a)) |

**MUST changes vs the proposal:**
1. **Summaries: 400 → 365 days.** 400 is hard to defend under data-minimisation and is an awkward audit boundary. 365 (a clean annual cycle) preserves the longitudinal-coaching value and is defensible.
2. **"Persistent" is not "forever."** Facts/preferences/goals get a **dormancy backstop**: any memory not retrieved or reinforced within **24 months** auto-expires via `expires_at`. This caps unbounded accumulation and is the data-minimisation story for an auditor.
3. **Audio default is 30 days, opt-in to 90.** The transcript already preserves the analysable content; the recording is for user playback. Voice is the most sensitive class, so it carries the shortest default and a separate consent toggle (not bundled with text memory).
4. **Legal basis = consent for the persistent layer, contract for the live session.** Do **not** rely on legitimate interest for persistent memory — consent is cleaner, matches the "explicit, granular, revocable" UX already proposed, and makes revocation (§3) unambiguous. This makes consent the legal anchor of the whole feature.
5. **`expires_at` must be set at write time** for every row (summaries: created_at + 365d; facts/etc.: created_at + 24mo, **bumped on each retrieval/reinforcement**). Object-store lifecycle rules on the transcript/recording buckets must mirror these windows — expiry is enforced by the store, never only in UI (ADR already says this; restating as a hard requirement).
6. **Account deletion cascades** to all of the above within the DSAR erasure SLA (§5), regardless of per-class window.

---

## 2. RLS mandated vs app-layer scoping (resolves open item #2)

**Decision: RLS is MANDATED on `coach_memory`** (and recommended on the other per-user PII tables: `session`, `session_event`, `analysis`). App-layer `(coach_id, user_id)` scoping remains the primary control; **RLS is the defense-in-depth backstop.**

**Rationale:** cross-user memory leakage is the single worst outcome for this product (user A sees what the coach "remembers" about user B). For a table where one missing `WHERE user_id = …` equals a cross-tenant PII breach, a database-level guarantee is the lowest-effort, highest-leverage control we can buy. App-layer scoping alone means every current and future query is one bug away from a breach; RLS makes that class of bug structurally impossible.

**Implementation:** request-scoped `SET LOCAL app.user_id = <authenticated uuid>` inside the transaction, with an RLS policy `USING (user_id = current_setting('app.user_id')::uuid)`. The BFF must run user-facing queries under a role subject to the policy (not a bypass/superuser role).

**Exception path (documented, not free):** if the existing connection-pooling posture (e.g. a transaction-mode pooler that breaks `SET LOCAL` semantics) makes per-request RLS genuinely infeasible, the fallback requires **CISO + CTO joint sign-off** AND these compensating controls, all of which are MUST if RLS is waived:
- All access to these tables funnels through a single tenancy-enforcing data-access module — no ad-hoc raw queries.
- A CI lint/test gate that **fails the build** if any query targets `coach_memory` outside that module.
- A scheduled **cross-tenant canary** in prod that asserts user A can never read user B's memory.

I expect RLS to be adopted; the bar to skip it is deliberately high.

---

## 3. Consent UX + record-of-consent storage (resolves open item #3)

Consent must be **freely given, specific, informed, unambiguous, granular, and revocable** (GDPR Art. 7). 

**UX (MUST):**
- A consent gate at **first Coach use**, *before* any memory row is written. **Not pre-ticked**, and **not bundled** into general ToS/privacy acceptance (specificity requirement).
- **Granular toggles**, independently controllable:
  - (a) **Persistent memory** — store summaries + facts/preferences/goals across sessions.
  - (b) **Audio recording retention** — keep the raw recording past the session.
  - Per-session **"Pause memory / don't remember this session"** is always available regardless of (a)/(b) and writes nothing.
- Plain-language disclosure at the gate covering: *what* is stored, *why*, *how long* (the §1 windows), that memory is **per-coach and never shared** across users/coaches, and *how to view / export / delete / revoke*. Suggested copy:

  > **Let this coach remember you?**
  > To pick up where you left off, [Coach] can remember a summary of your sessions and key facts you share (e.g. goals, preferences) — **only for this coach, never shared with other users or coaches.** Summaries are kept up to 12 months; facts until you delete them or 24 months of inactivity. You can view, export, or delete everything any time in *Memory settings*, and turn this off whenever you like.
  > ☐ Remember my sessions with this coach   ☐ Also keep my audio recordings (up to 90 days)

**Record-of-consent storage (MUST) — new entity `consent_record`** (append-only; never update-in-place):

| Column | Notes |
|---|---|
| `id` | PK |
| `user_id` | FK |
| `scope` | `coach:<coach_id>` (or `global`) |
| `consent_type` | `persistent_memory` \| `audio_retention` |
| `action` | `granted` \| `revoked` |
| `policy_version` | version of the consent text shown |
| `policy_text_hash` | hash of the exact wording presented (proves *what* they agreed to) |
| `locale` / `ui_surface` | which screen/language |
| `source_ip`, `user_agent` | provenance |
| `created_at` | event time |

- **Append-only:** a revocation is a new row, not a mutation — we must reconstruct consent state at any past timestamp.
- **Consent proof outlives the data:** retain `consent_record` for **processing duration + 6 years** (limitation period) even after the underlying memory is erased. Erasing memory must not erase the proof that consent was given/withdrawn.
- **Revocation behaviour:** revoking (a) immediately stops new writes and, because the basis is consent, **offers the user erasure of existing consent-based memory** (default action = wipe; they may explicitly choose "stop but keep"). Revoking (b) stops retaining new recordings and purges retained ones on the erasure SLA.

---

## 4. Realtime-vendor data-residency / sub-processor constraints (resolves open item #4)

The vendor is **not yet chosen** — [ADR-003](ADR-003-realtime-voice-build-vs-buy.md) is blocked on the Slice-0 measured spike (`RESULTS.md` empty). So rather than name constraints for a specific vendor, I am setting a **privacy/data-protection gate that the ADR-003 recommendation MUST satisfy.** EA: please add this as a **scored row in the ADR-003 rubric** and a section in the vendor scorecard. Privacy is a selection criterion, not an afterthought.

**Any candidate (OpenAI Realtime, Gemini Live, LiveKit Agents, Pipecat, Cartesia) MUST clear all of these before *real user* PII flows** (the spike itself may run on synthetic/seed audio only — no real PII to an un-DPA'd vendor):

1. **Signed DPA** with GDPR Art. 28 processor terms; **SCCs / UK IDTA** for any transfer outside an adequacy region.
2. **No training on our data** — contractual guarantee that audio/transcripts are never used to train or improve vendor models (the API/realtime "no-train / zero-retention" tier). **Hard gate.**
3. **Zero / minimal vendor-side retention** — configure zero-retention and disable human abuse-monitoring review where the vendor offers it; any unavoidable vendor retention must be disclosed and sit *within* our §1 windows.
4. **Data residency** — ability to pin processing to our primary region(s) for the user base, or a documented, lawful transfer mechanism. Capture region support in the scorecard.
5. **Sub-processor disclosure + flow-down** — vendor enumerates its own sub-processors; we add them to our published sub-processor list; the no-train/retention/residency terms flow down.
6. **Security & breach SLA** — SOC 2 Type II or ISO 27001, plus a breach-notification commitment (≤ 72h to us) in the DPA.

**Privacy weighting note for the rubric:** a **self-hosted cascade** (LiveKit/Pipecat running our own STT/TTS/LLM calls) keeps audio inside our trust boundary except for the underlying model provider — a materially smaller PII surface and fewer sub-processors than a hosted S2S API. This is a genuine privacy advantage and should be reflected in the existing *Lock-in / portability* criterion (or a new privacy criterion), not treated as latency/cost only.

---

## 5. DSAR SLA + audit-logging requirements (resolves open item #5)

**DSAR (access / export / erasure / rectification) — MUST:**
- **Acknowledge ≤ 72h; fulfil ≤ 30 calendar days** (GDPR Art. 12; comfortably covers CCPA's 45d). Because View / Export / Delete / Wipe are first-class in-app (ADR §User controls), the *common* case is **self-service and effectively immediate**; the 30-day clock is the backstop for manual/escalated requests (internal target 14d).
- **Erasure scope & SLA:** in-app "wipe memory" = immediate logical delete + **hard purge within 7 days** across **all** of: `coach_memory` rows, their **embeddings**, derived rows, the linked transcripts/recordings under consent-based retention, **and** a vendor-side deletion request (§4) where the vendor retained anything.
- **Backups:** state the truth — erased data is purged from backups on the **backup rotation cycle**; document the max (e.g. "within 35 days of the erasure request"). Do not claim instant backup deletion.
- **Erasure verification:** an automated post-purge check asserting **zero residual rows** for the `(coach_id, user_id)` / user, recorded against the DSAR.
- **Export:** machine-readable (JSON) bundle of all memory + transcripts; self-service.

**Audit logging — MUST:**
- **Log every privacy-relevant event:** memory **write**, memory **retrieval into agent context** (who/when/which coach/how many records — **not the content**), memory **delete / wipe**, **consent grant/revoke**, **export**, every **DSAR action**, and **any staff/admin access** to a user's memory, transcripts, or recordings.
- **Staff/admin access is the top insider-risk surface** — it MUST be logged, justified, and **break-glass** (access generates an alert), never silent.
- **Log hygiene:** audit logs are **append-only / tamper-evident**, access-restricted, and **must not contain the PII content itself** — log IDs and references, not memory bodies. Retain **≥ 18 months** (security/forensics).
- **Detection:** logs feed alerts for anomalies — bulk memory reads, cross-tenant access patterns, retrieval volume spikes — so a leak or scraping attempt is caught, not discovered later.

---

## 6. Additional boundary requirement (voice = biometric-adjacent)

Add to ADR-004 **Boundaries**: the platform **must not build voiceprint / speaker-identification / voice-biometric features** on recordings or audio without a **new ADR + CISO + legal review**. Today we process voice to *converse*, not to *identify a person* — so it is not biometric special-category data. The moment audio is used to identify/authenticate a person, it becomes biometric data triggering GDPR Art. 9 (special category) and US state laws with private rights of action (Illinois **BIPA** — written consent + published retention schedule + statutory damages; Texas CUBI; Washington). That is a deliberate, separately-governed decision, not an incremental feature.

---

## Conditions to move ADR-004 → Accepted (checklist for EA)

**MUST (gates):**
- [x] Retention table (§1) folded into ADR-004 Retention; summaries 400→365d; 24-month dormancy expiry on facts/etc.; audio default 30d / opt-in 90d.
- [x] Legal basis stated: consent for the persistent layer + audio retention; contract for the live session.
- [x] RLS mandated on `coach_memory` in ADR-004 + ERD tenancy note (replace "RLS policy pending CISO decision"); exception path documented with its compensating controls.
- [x] `consent_record` entity (§3) added to the ERD; consent UX requirements + granular toggles in ADR-004 User controls; append-only + 6-year proof retention.
- [x] DSAR SLAs (ack 72h / fulfil 30d / hard-purge 7d / backups ≤35d) and audit-logging requirements (§5) added to ADR-004.
- [x] Voice/biometric boundary (§6) added to ADR-004 Boundaries.
- [x] ADR-003 gains a privacy/data-protection vendor gate (§4) as a scored rubric row + scorecard section.

**SHOULD (recommendations, not gates):** RLS extended to `session`/`session_event`/`analysis`; anomaly-detection alerting on retrieval volume. *(Both also reflected — ERD §Tenancy "RLS should extend"; ADR-004 §audit "feed anomaly alerts".)*

Once the MUST items are reflected in the ADR-004 text, this constitutes CISO privacy sign-off and ADR-004 is eligible for Accepted.

---

## Confirmation pass (SAU-178 · 2026-06-06)

Fast confirmation pass on EA's revised text. **All 7 MUST gates verified folded in — confirmed, no changes requested. CISO privacy sign-off is final; ADR-004 → Accepted.**

| # | MUST condition | Verified in | Verdict |
|---|---|---|---|
| 1 | Retention: summaries 365d, 24-mo dormancy, audio 30/90d, transcripts 90/365d; `expires_at` at write + object-store mirror | ADR-004 §Retention table + rules | ✅ |
| 2 | Legal basis: consent (persistent + audio) / contract (live session); legitimate-interest explicitly rejected | ADR-004 §Retention line "Legal basis ="; Alternatives #4 | ✅ |
| 3 | RLS **mandated** on `coach_memory` (`SET LOCAL` pattern, non-bypass role); high-bar exception path with all 3 compensating controls; ERD "pending CISO decision" replaced | ADR-004 §Tenancy & RLS; ERD lines 13, 181 | ✅ |
| 4 | `consent_record` entity (append-only, `policy_text_hash`/`source_ip`/`user_agent`) + `USER ||--o{ CONSENT_RECORD`; granular non-pre-ticked/unbundled toggles + per-session pause; 6-year proof retention; revocation→erasure default | ERD CONSENT_RECORD + relation; ADR-004 §User controls | ✅ |
| 5 | DSAR ack ≤72h / fulfil ≤30d / hard-purge ≤7d (rows + embeddings + transcripts/recordings + vendor-side) / backups ≤35d / zero-residual verify; audit every write/**retrieval**/delete/consent/export/DSAR + **all staff access (break-glass + alert)**, append-only, no PII content, ≥18-mo | ADR-004 §DSAR SLA + audit logging | ✅ |
| 6 | No voiceprint / speaker-ID / voice-biometric without new ADR + CISO + legal (GDPR Art. 9 / BIPA) | ADR-004 §Boundaries | ✅ |
| 7 | ADR-003 privacy gate: scored rubric row (10%, weights rebalanced to 100%, latency still dominant), hard-gate preamble (no-train + Art. 28 DPA = disqualified), full 6-requirement gate section, synthetic-audio-only spike, self-host advantage, Privacy column in Slice-0 scorecard | ADR-003 §rubric + §Privacy gate + §Measured data | ✅ |

**SHOULD items** (RLS-extend to `session`/`session_event`/`analysis`; retrieval-volume anomaly alerting) are also reflected — above and beyond the gate.

**Residual note (non-blocking, for build time, not a gate):** when `consent_record.source_ip`/`user_agent` are logged for provenance, treat them as PII subject to the same DSAR/retention discipline — they ride the 6-year consent-proof window by design, which is the intended exception; just ensure they are not surfaced into general analytics.

This completes the CISO confirmation pass. ADR-004 status flipped to **Accepted**; README + escalations updated to match.
