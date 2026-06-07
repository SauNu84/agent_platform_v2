# Agent Platform — Slice 1: the Scenario atom

The Scenario is the core primitive ([ADR-001](../docs/adr/ADR-001-scenario-as-core-primitive.md)); every other
feature (Coach, Course, Analyst, History) composes or projects over it. This slice
stands up the atom end-to-end: **MD compiler → CRUD → Library → shared detail shell → live voice**.

Parent design: [`docs/SAU-171-brandstorm-architecture.md`](../docs/SAU-171-brandstorm-architecture.md) ·
Schema: [`docs/architecture/ERD.md`](../docs/architecture/ERD.md) (SAU-175) · Issue: SAU-200.

## Run it

```bash
npm install
npm run dev            # http://localhost:3000 → /library
```

With no `DATABASE_URL`, the app uses a non-durable **in-memory store** seeded from
`content/scenarios/*.md` so the Library has data with zero infra. For Postgres:

```bash
export DATABASE_URL=postgres://localhost:5432/agent_platform
npm run migrate        # apply db/migrations/*.sql (expand-contract)
npm run seed           # compile content/scenarios/*.md into the DB
```

Checks: `npm run typecheck` · `npm run lint` · `npm test` (compiler round-trip, CRUD,
voice-session persistence + metering — all run hermetically, no infra).

## How it fits together

```
content/scenarios/*.md   ── source of truth (ADR-002)
        │  compiler (src/compiler/compile.ts): parse frontmatter → Zod validate → content_hash
        ▼
   scenario row + content_source   ── canonical projection (db/migrations/0001)
        │  service (src/services/scenarios.ts)  ── CRUD + compile-upsert
        ▼
   API routes (src/app/api/scenarios/**)  ── list / create / get / edit / delete / sessions
        │
        ▼
   Library UI (/library) + shared DetailShell (/scenarios/[slug])
        │  Join
        ▼
   voice seam (src/voice/realtime-interface.ts, ADR-003) — OpenAI | mock
        │  session-service: run → persist transcript + session_events → METER voice_usage
        ▼
   session / session_event / voice_usage rows
```

### Content-as-code (ADR-002)
MD + YAML frontmatter is authoritative; the DB row is a projection tagged with
`content_hash` + git `revision` for drift detection. A malformed file fails Zod
validation and **never reaches the DB** (see `compiler.test.ts`). The same schema
guards the JSON CRUD path, so the API can't write a row the compiler would reject.

### The realtime voice seam (ADR-003) — swap-ability
Everything depends only on `RealtimeVoiceProvider` (`startSession(scenario) → events → transcript`).
`Join` runs a session through this seam and persists the transcript + meters usage.

- **Dev/demo (default):** the deterministic `mock` vendor — `Join` works with no key.
- **OpenAI:** set `OPENAI_API_KEY` (+ `REALTIME_VENDOR=openai`). Same seam, reusing the
  Slice-0-proven adapter (`src/voice/adapters/openai.ts`, SAU-176).
- **Browser live voice:** `/api/realtime/token` mints an ephemeral client secret so the
  browser runs the session client-side via the same seam and posts its transcript back
  to `/api/scenarios/[slug]/sessions` — persisted + metered identically. (The in-browser
  WebRTC mic loop is the next increment; it needs a live key + mic to exercise, so the
  verifiable `Join` here uses the server-driven path.)

### Voice metering (Slice-1 requirement)
Every session records a `voice_usage` row: duration → `voice_minutes`, plus measured
token counts (`response.done.usage` on OpenAI). **Cap enforcement lands in Slice 2**;
this slice only *records* so the enforcement layer has real data.

## Slice boundaries (deferred, per ERD/build plan)
- coach / course / course_scenario → Slice 3 · analysis (Analyst) + History view → Slice 2
- coach_memory / consent_record + Postgres RLS → Slice 3/4 · auth/`user` table (session.user_id
  is a nullable uuid without FK until then) · in-browser WebRTC voice loop.

## Known follow-ups
- **Next.js** pinned to the latest 14.2.x patch (14.2.35). `npm audit` proposes Next 16
  (breaking major) for two remaining advisories — a separate upgrade decision, not this slice.
