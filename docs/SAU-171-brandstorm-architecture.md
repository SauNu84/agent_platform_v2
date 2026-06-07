# SAU-171 Brandstorm — Agent Platform Architecture

**Author:** CTO · **Date:** 2026-06-06 · **Status:** Draft for CEO/CPO review
**Reference product:** ToughTongue AI (`app.toughtongueai.com`) — recon performed live via Playwright on 2026-06-06.
**Cross-checked against** the 9 reference screenshots attached to SAU-171 (Scenario, Scenarios-detail, course/course_detail_l1/l2, coach/coach_detail, Analyst, Session History).

> **Verified UI insight (from the board's screenshots):** Scenario detail, Coach detail, and each in-course scenario all render the **identical detail shell** — a `Details / Sessions / Analytics` tab set over an avatar + "Overview" + "Your Instructions" + a `Join` action. This is direct visual proof of the single-primitive thesis in §3: they are the same object with different composition around it. The left nav is fixed: **Scenarios · Course · Coach · | Analytics · History · | Developer Tools · Documentation**, with a credit `Balance` meter — i.e. the five core features the brief names, plus billing.

---

## Bottom line (read this first)

- The reference product looks like five features, but it is really **one primitive (the Scenario) with two composition patterns (Coach, Course) and two read-models (Analyst, History) layered on top.** Get the primitive right and the rest is cheap. Get it wrong and we rebuild everything later. **This is the whole point of the brandstorm — and it's good news: the design collapses to one core object.**
- The genuinely hard, high-risk part is **not** the CRUD or the libraries. It is the **realtime multimodal conversation pipeline** (speech-in → LLM-with-tools → speech-out, plus tone/expression and agent tools like slides/whiteboard/code). **Recommendation: buy the realtime transport, build the content + composition + analytics layer.** That is where our differentiation and our risk both live.
- "Set up by MD file" (which the brief repeats three times) is a real architectural stance, not a UI detail. I'm proposing **content-as-code**: every Scenario / Coach / Course is a Markdown file with YAML frontmatter that compiles to the canonical record. Versionable, reviewable, diff-able, AI-generatable. This is a strong, opinionated foundation and I recommend we commit to it.
- **Confidence:** product decode = *verified* (live recon + API docs). Architecture proposal = *recommendation*, pending CEO/CPO scope and a build-vs-buy spike on the voice layer.

---

## 1. What I did this heartbeat

The brief asked to "use Playwright to access app.toughtongueai.com." The full app is login-gated, but the **public surface is rich** and the **public API documentation is complete**. I rendered the SPA with headless Chromium (WebFetch only sees "Loading…") and extracted the live data model and routing. Everything in §2 is verified from that recon, not assumed.

## 2. The reference product, decoded (verified)

**Three user-facing libraries, one shared engine:**

| Surface | Route | What it is (verbatim from product) |
|---|---|---|
| **Scenarios** | `/library` | "Hyper-realistic AI roleplay to practice high-stakes conversations." Filterable by role (PM, SWE, Leadership, Sales, MBA). One-off role-plays. |
| **Coach** | `/coach` | "Little, topic-focused coaches that **remember every conversation**." Each coach has **Join** + **Schedule** actions. (Morning Reflection, Language coaches, SQL Tutor, YC Application Coach…) |
| **Course** | `/course` | "Structured learning paths with immersive AI role-plays." Each course is an **ordered collection of N scenarios** (e.g. "MBA Admission Prep — 34 scenarios"), marked Public/Private. |

**The agent capabilities (their marketing + docs, verified):** agents are *agentic, not chatbots* — they use real tools (generate images, navigate **slides**, sketch **diagrams**, **whiteboard**, **code editor**, cards), and are **multimodal** (read tone + facial expression). Deploy via **iframe, API, or white-label page**. Realtime stack uses a **Cartesia TTS/STT cascade** variant (seen on a live scenario). Also: **Meeting Bots** (agent joins Google Meet to run a standup) and **Phone Calls** (outbound/inbound calling agents).

**The verified data model (from the public API reference):**

```
POST /scenarios   — the atomic unit. Fields:
  name (req), description, ai_instructions (system prompt / persona),
  rubrik (evaluation criteria), is_public, appearance{voice, language_code},
  user_metadata{arbitrary k/v}, created_at, updated_at
```

```
Sessions   — one conversation run: create, list, get details, batch fetch,
             analyze, post-process. Holds transcript + recording + events.
POST /sessions/analyze  → returns (verified shape):
  evaluation{ overall_score, strengths, weaknesses, detailed_feedback,
              report_card[{topic, score, note, weight}], final_score }
  improvement{ improvement_areas, action_items, resources }
  ...scored against the scenario's `rubrik`.
```

Other API resources: **Meeting Bots** (schedule/list/delete), **Phone Calls** (initiate/batch/list), **Commerce** (purchases, subscriptions, access tokens), **Analytics** (unified), **Account** (balance/credits). Auth = Bearer API keys. Embedding = iframe + iframe events.

## 3. The core architectural insight

> **Scenario is the atom. Coach and Course are compositions of it. Session is the runtime artifact. Analyst and History are projections over Sessions.**

This is the single most important design decision, and the reference product confirms it: the *only* creatable agent object in their API is the Scenario. Everything else is structure around it.

```
                 ┌───────────────────────────┐
                 │         SCENARIO          │  ← the atom (agent definition:
                 │  persona, rubric, voice,  │     prompt + rubric + voice + tools)
                 │  tools, multimodal config │
                 └─────────────┬─────────────┘
            composition pattern │ composition pattern
         ┌──────────────────────┴───────────────────────┐
         ▼                                                ▼
 ┌───────────────┐                              ┌──────────────────┐
 │     COACH     │ = Scenario(s)                │      COURSE      │ = ordered
 │  + long-term  │   + persistent memory        │  list of Scenario │   Scenarios
 │    memory     │   + schedule + "join"        │  refs + levels    │   (l1 module /
 │  + recurrence │                              │  (l1/l2) + coach  │    l2 lesson)
 └───────┬───────┘                              └─────────┬────────┘
         │                runtime                          │
         └───────────────────┬────────────────────────────┘
                             ▼
                    ┌──────────────────┐
                    │     SESSION      │  one conversation run:
                    │ transcript + a/v │  transcript, recording, events
                    │ + multimodal evts│
                    └────────┬─────────┘
              projection      │      projection
         ┌───────────────────┴────────────────────┐
         ▼                                          ▼
 ┌────────────────┐                        ┌──────────────────┐
 │    ANALYST     │ rubric-scored          │     HISTORY      │ user-facing
 │  insights per  │ evaluation +           │  timeline / log  │ activity feed
 │  session+user  │ improvement plan       │  of sessions     │
 └────────────────┘                        └──────────────────┘
```

**Why this matters:** if we instead modeled Coach, Course, and Scenario as three independent CRUD tables (the naive reading of the brief), we'd duplicate persona/voice/rubric logic three times and pay for it forever. Modeling Coach and Course as *compositions over Scenario* means the conversation engine, the authoring pipeline, and the analytics layer are each built **once**.

## 4. Canonical domain model + the "MD file" principle

The brief says — three times — "**It can be set up by MD file.**" I'm treating that as a first-class requirement and proposing **content-as-code**:

> Each entity is authored as a **Markdown file with YAML frontmatter**. A compiler validates it against a schema and upserts the canonical DB record. The MD file is the source of truth; the DB row is a projection. Content lives in git → versioned, peer-reviewed, diff-able, and **AI-generatable** (the brief wants courses "created by AI" — an LLM emitting validated MD is far safer than an LLM writing to a DB directly).

**Scenario** (`scenarios/sales-objection.md`)
```yaml
---
id: sales-objection-handling
name: Sales Objection Handling
persona: |              # → ai_instructions
  You are a skeptical enterprise buyer evaluating a SaaS product...
rubric:                 # → drives Analyst scoring
  - topic: Discovery Quality      weight: 40
  - topic: Objection Handling     weight: 40
  - topic: Tone & Empathy         weight: 20
voice: { name: Aoede, language: en-US }
tools: [slides, whiteboard]          # multimodal agent tools
visibility: public
metadata: { department: sales, difficulty: intermediate }
---
# Body = optional briefing / context / reference docs the agent can use
```

**Coach** = `extends` a scenario (or inlines one) + `memory` + `schedule`:
```yaml
---
kind: coach
name: Pitch Coach
scenario: sales-objection-handling   # or inline persona
memory: { scope: per_user, retention: persistent }
schedule: { cadence: weekly, channel: [web, phone] }
---
```

**Course** = an **ordered list of Scenario references**, optionally bound to a coach. The brief's "course_detail_l1/l2" maps to a verified **2-level hierarchy** (confirmed in the screenshots): **l1 = the course page** (title, `Subscribe` / `Play All` / `Share`, a `progress` bar like "0 / 36 completed", visibility, and the numbered scenario list each with a `Start` button); **l2 = an individual scenario's detail page** reached from that list (the shared Details/Sessions/Analytics shell). It is a flat course→scenarios list, *not* module/lesson nesting — keep it that simple unless product asks otherwise.
```yaml
---
kind: course
name: MBA Admission Prep
visibility: public
coach: mba-coach                      # optional binding
scenarios:                            # ordered; the "Play All" sequence
  - kellogg-alumni-interview
  - hbs-admissions-committee
  - wharton-advisor
# optional grouping only if product needs it later:
# sections: [{ title: "Behavioral", scenarios: [...] }]
---
```

**Session, Analyst, History** are runtime/derived — never hand-authored. Session captures transcript + recording + multimodal events. Analyst is the rubric-scored evaluation (exact shape verified in §2). History is a per-user projection of Sessions.

## 5. System architecture

```
┌──────────────┐   ┌─────────────────────────────────────────────┐
│  Authoring   │   │                  Clients                     │
│  (MD in git) │   │  Web app · iframe embed · API · phone · meet  │
└──────┬───────┘   └───────────────┬─────────────────────────────┘
       │ compile + validate        │
       ▼                           ▼
┌──────────────┐         ┌───────────────────┐
│  Content     │         │   Core API/BFF    │  scenarios, coaches, courses,
│  Compiler    │────────▶│  (Next.js/Node)   │  sessions, analytics, commerce
└──────────────┘         └─────────┬─────────┘
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        ▼                          ▼                            ▼
┌────────────────┐   ┌──────────────────────────┐   ┌────────────────────┐
│   Postgres     │   │  Realtime Conversation   │   │  Analysis worker    │
│ (canonical +   │   │  Service  ⚠ HIGH RISK    │   │ (rubric scoring via │
│  memory store) │   │  STT→LLM(+tools)→TTS,    │   │  LLM, async queue)  │
│  + object store│   │  vision/tone, transport  │   └────────────────────┘
│  for recordings│   │  ── BUY THIS LAYER ──    │
└────────────────┘   └──────────────────────────┘
```

**The one component that decides the project: the Realtime Conversation Service.** Sub-300ms voice latency, barge-in, tool-calling mid-turn, tone/expression input, and graceful degradation are *hard*. ToughTongue buys it (Cartesia cascade + Gemini/realtime models). **We should too.** Candidates for the build-vs-buy spike: **LiveKit Agents, Pipecat, OpenAI Realtime API, Google Gemini Live**. We build the *orchestration and tools* on top; we do not build WebRTC transport, echo cancellation, or our own STT/TTS.

This is the cleanest seam in the system: a stable internal interface (`startSession(scenario) → events stream → transcript`) lets us swap the realtime vendor without touching the rest of the platform. **Make that interface a hard boundary from day one.**

## 6. The five core features → the model

| Brief's feature | In our model | Built from |
|---|---|---|
| **Scenario** (lib, MD-config) | The atom | Scenario table + MD compiler |
| **Course** (AI-created, MD, links to coach) | Composition: ordered Scenario refs + l1/l2 levels + coach binding | Course table (refs, no duplication) + AI-generates-MD pipeline |
| **Coach** (lib, MD-config) | Composition: Scenario + persistent memory + schedule | Coach table + memory store + scheduler |
| **Analyst** (user insight during interaction) | Projection: rubric-scored session analysis + creator aggregates | Analysis worker (verified output shape) + "Creator Analytics" view: KPI cards (total scenarios/sessions, avg sessions/scenario, avg duration) + per-scenario table + CSV export |
| **History** (activity log) | Projection: per-user Session timeline | "Session History" read-model over Sessions: filterable table (scenario, created, duration, status Active/Completed) with `Analyze` / `Restore` / `Export CSV` actions |

Every feature reduces to **one new table + reuse of the shared engine**. No feature requires a second conversation engine, authoring pipeline, or analytics path. That is the test of whether the architecture is "good," and it passes.

## 7. Tech stack — default to boring, reuse what we run

The org already operates a Phase-2 commercial platform (Next.js, Postgres, Stripe, dbt, object storage, CI). I recommend **building on that stack, not beside it**:

- **Frontend / BFF:** Next.js (already in house).
- **Canonical store:** Postgres. Memory + transcripts also Postgres to start (pgvector for memory retrieval); only split out if scale demands it.
- **Recordings/artifacts:** existing object store (S3/MinIO).
- **Async analysis:** a queue + worker (rubric scoring, post-processing) — keep it off the request path.
- **Billing/credits:** reuse existing Stripe + usage-metering (the reference has Commerce + Account/balance; we already shipped subscriptions in Phase 2).
- **Realtime voice:** **BUY** (spike: LiveKit / Pipecat / Gemini Live / OpenAI Realtime).
- **AI content generation:** Claude for course/scenario MD generation (validated against schema before commit).

No new datastore, no microservice sprawl, no resume-driven architecture. The novel surface area is deliberately confined to (a) the MD compiler and (b) the realtime-vendor adapter.

## 8. Decisions that need an ADR (I'll have the Enterprise Architect formalize)

1. **ADR — Scenario as the core primitive; Coach/Course as compositions.** (Recommended: accept.)
2. **ADR — Content-as-code: MD+frontmatter is the source of truth; DB is a projection.** (Recommended: accept; the brief demands it.)
3. **ADR — Build-vs-buy on the realtime conversation layer.** (Recommended: buy; decide vendor after a 1-week spike with a latency/cost/tool-calling benchmark.)
4. **ADR — Memory model for Coaches** (per-user persistent memory: storage, retrieval, user controls, retention/privacy).
5. **ADR — Multimodal tool protocol** (how agents invoke slides/whiteboard/code-editor; the stable internal event contract).

## 9. Risks (ranked by danger, not annoyance)

- **Realtime voice quality & cost** — *most dangerous.* Latency/quality define whether the product feels real; per-minute inference + TTS/STT cost defines unit economics. Mitigation: vendor spike with a hard latency+cost benchmark *before* committing the architecture.
- **AI-generated course quality** — "courses created by AI" can produce plausible-but-wrong content. Mitigation: AI emits *validated MD*, human/coach review gate before publish.
- **Memory privacy** — coaches "remember every conversation." This is PII and a compliance surface. Mitigation: explicit user controls + retention policy + CISO review (ties to our existing PII work).
- **Scope creep** — meeting bots, phone calling, white-label, marketplace ("Remix"/fork) are all visible in the reference. They are *not* core. Defend the 5-feature core until the vertical slice works.

## 10. Recommended build sequence (thin vertical slice first)

1. **Slice 0 — prove the risk.** One hardcoded Scenario → one live voice Session → transcript saved. Validates the bought realtime layer end-to-end. *Nothing else matters until this works.*
2. **Slice 1 — the atom.** MD compiler + Scenario CRUD + library UI + embed.
3. **Slice 2 — projections.** Session capture → Analyst (rubric scoring) → History timeline.
4. **Slice 3 — compositions.** Course (ordered scenarios, l1/l2) + Coach (memory + schedule).
5. **Slice 4 — AI authoring.** LLM generates Course/Scenario MD against schema.
6. **Later (explicitly deferred):** meeting bots, phone calling, white-label, remix/marketplace, monetization tuning.

## 11. Open questions for CEO / CPO (blocking full scope, not the slice)

1. **Audience:** consumer (practice difficult conversations) or B2B builder platform (deploy agents via API/iframe)? The reference is both; we likely can't be both at MVP. *This changes the roadmap more than any technical choice.*
2. **Voice mandatory at MVP, or is text/chat acceptable for slice 1?** (Voice is the hardest + most expensive part.)
3. **Multimodal tools (slides/whiteboard/code) — core or fast-follow?** They're a big build; the brief lists them implicitly via the reference, not explicitly.
4. **Monetization at MVP** (credits/subscription) — reuse Phase-2 billing now, or defer?

## 12. Disposition & next actions

- **This doc** is the durable design artifact — the brandstorm the brief asked for.
- **Delegating to Enterprise Architect:** formalize ADRs 1–5, produce the ERD + C4 diagrams, and run the **realtime voice build-vs-buy spike** with a latency/cost benchmark (child issue).
- **Routing to CEO/CPO:** the four scope questions in §11 — these gate the full roadmap and are theirs to answer.
- **Recommendation:** approve the core model (§3) and the content-as-code stance (§4) now; let the EA spike de-risk the voice layer (§5) in parallel; lock full scope once §11 is answered. Then I'll convert the approved design into an assigned, parallelized build plan (Slices 0–4).
