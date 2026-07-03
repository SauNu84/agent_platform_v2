# PLAN — What's going on & what's next

_Last synced: 2026-07-03 (SAU-393). Canonical status lives in the Paperclip
issue tracker (`SAU-###`); this file is the human-readable snapshot._

## Where we are

Proviso has pivoted from an AI voice-roleplay MVP into a **compliance-grade Agent
Framework** sold into regulated phone/messaging work. The commercialization epic
(**SAU-345**) reframed the product around the compliance wedge and shipped five
workstreams. The two lead archetypes are built and proven end-to-end on synthetic
(and, for Clinic, live) call paths.

### Landed on `main`

- **Clinic Secretary** — inbound intake + calendar scheduling over voice + SMS;
  no-code self-service clinic setup; multi-clinic tenancy + per-clinic dashboard;
  live-call proven via a synthetic caller over the real Twilio↔Realtime bridge.
- **Collections agent** — outbound compliance engine (`canDialNow()` with 7
  server-side, un-overridable guardrails), debtor data layer with PII-at-rest +
  audit ledger, outbound dialer (fail-closed to mock), per-lender ops dashboard,
  and a 10/10-passing synthetic compliance case study.
- **Proviso brand + marketing** — rename to Proviso across the app shell; public
  `/proviso` landing page on the compliance wedge with a sales-led CTA.
- **Product analytics** — PII-free event taxonomy, append-only `product_event`
  store, and CMO funnel/activation/retention read-models; Clinic value +
  top-of-funnel events wired at the finalize/setup seams (SAU-358/359).
- **Platform** — Super Agent type; in-app Twilio config on Settings (SAU-381);
  fail-soft decrypt so Settings survives key rotation (SAU-382).

## Next steps

### 1. Land design partners (highest priority — validates PMF)
- **SAU-352** design-partner sourcing: wave-1 outreach released (clinic
  prospects). Awaiting inbound replies; **day-15 pulse due 2026-07-04**.
  Goal: **≥1 verbal design-partner commit by 2026-07-19.**
- Positioning is sales-led and gated, not broad/PLG — the clinic market is a red
  ocean; we win on the compliance wedge, not receptionist parity (SAU-343).

### 2. Collections go-live gate (unblocks the durable-revenue archetype)
- **SAU-331**: 12-item go-live checklist + Legal counsel sign-off. **No real
  outbound call is placed until this is all-green.** Collections is synthetic-only
  today by design.

### 3. Brand infrastructure (operator action)
- **SAU-357**: domain decided **`joinproviso.com`**. Registration is blocked on
  the operator saving `PORKBUN_API_KEY` + `PORKBUN_SECRET_KEY` in the CMO adapter
  (board "Accept" signals intent but does not write a secret). Then: register →
  DNS → `@proviso` handles → opportunistic `proviso.ai` drop-catch (exp 2026-08-12).

### 4. Deferred / shelved (do not restart without a board signal)
- **HRM Super-Agent archetype** — deferred, Clinic-first (SAU-361, held open by
  placeholder SAU-372). Feasibility says GO single-session (~1 week) when resumed.
- **Meeting / Notetaker archetype** — shelved; inert `meeting.*` taxonomy has been
  stripped (SAU-380). Live-join is buy-don't-build if ever revived.

## Continuing development

- **Where the work is tracked:** Paperclip issues (`SAU-###`). Each shipped issue
  has a memory note; the epic is SAU-345.
- **Reusable agent skills** for continuing this project (CTO/CPO/CMO advisors,
  Paperclip coordination, PARA memory, QC/PRISM, etc.) live in the **agent home /
  `claude-skills` repo**, invoked via the Claude Code Skill tool — they are *not*
  vendored into this repo. `.claude/` here is transient worktree scratch and is
  gitignored.
- **Engineering gates before any merge to `main`:** `npm run typecheck`,
  `npm test`, `npm run build` (all green). Regulated features are
  **synthetic-first**; real external calls stay gated on their compliance
  checklist. Merges to `main` are CTO fast-forwards of verified branches.
