# Agent Platform — MVP POC

Hyper-realistic AI voice roleplay to practice high-stakes conversations. The
Scenario is the core primitive ([ADR-001](../docs/adr/ADR-001-scenario-as-core-primitive.md));
every other feature (Coach, Course, Analyst, History) composes or projects over
it. The POC stands up the full MVP UI end-to-end — **Scenarios, Courses, Coaches,
Analytics, History** + live voice behind a seam — over a **MD compiler → CRUD →
Library → shared detail shell → live voice** spine.

Parent design: [`docs/SAU-171-brandstorm-architecture.md`](../docs/SAU-171-brandstorm-architecture.md) ·
Schema: [`docs/architecture/ERD.md`](../docs/architecture/ERD.md) (SAU-175) · Issue: SAU-200.

## Run it (zero infra)

Run each line on its own. **Do not paste a trailing `# comment`** after the
command — the shell passes the `#` and the rest to `next` as bogus arguments and
the dev server aborts with `Invalid project directory ... /app/#`.

```bash
cd app
npm install
npm run dev
```

Then open the URL the server prints. Default is <http://localhost:3000>; if 3000
is busy Next picks the next free port (e.g. 3001) — watch the console line
`- Local: http://localhost:PORT`. The home page (`/`) is the POC overview; it
links into Scenarios, Courses, Coaches, Analytics, and History.

With no `DATABASE_URL`, the app uses a non-durable **in-memory store** seeded from
`content/` (3 scenarios, 1 course, 1 coach) so every section has data with zero
infra.

## Run it for real (Postgres + OpenAI)

Two independent switches. Turn on either, both, or neither — the app degrades
to mock/in-memory when a credential is absent, so partial setups still boot.

### 1. Real Postgres (durable store)

A `docker-compose.yml` ships a ready Postgres. It uses the **pgvector** image
(not plain `postgres`) because migration 0003 needs the `vector` extension, and
maps host port **5433** (not 5432) so it won't collide with any Postgres you
already run locally. Run each line on its own:

```bash
cd app
docker compose up -d

# Migrations (DDL) + seed run as the owner/superuser role `agent`:
export DATABASE_URL=postgres://agent:agent@localhost:5433/agent_platform
npm run migrate          # migration 0007 creates the restricted `app_rw` role
npm run seed

# The app SERVES requests as the non-superuser `app_rw` role, so the Slice-5
# ownership/RLS policies actually engage (see "Why two roles" below):
export DATABASE_URL=postgres://app_rw:app_rw@localhost:5433/agent_platform
npm run dev
```

> **Why two roles (SAU-233).** Postgres superusers — and any `BYPASSRLS` role —
> bypass Row-Level Security *entirely*, even `FORCE`. The docker-default `agent`
> role is a superuser, so if the app connected as `agent` the Slice-5 RLS
> policies would be inert (the API-layer guards would still enforce, but the
> DB-layer backstop wouldn't). `app_rw` is a `NOSUPERUSER NOBYPASSRLS` login role
> with table DML + sequence grants and nothing else, created by migration 0007.
> Keep migrations and the seed path on `agent` (they need DDL / write platform
> content); point only the runtime `DATABASE_URL` at `app_rw`. Verify it bites:
> `DATABASE_URL=postgres://app_rw:app_rw@localhost:5433/agent_platform npm test`
> runs `tests/rls.test.ts` for real (it self-skips under a superuser role).
>
> The compose file also flips host auth from initdb's default `trust` to
> `scram-sha-256`, so passwords are actually verified on the published port. That
> takes effect on a **fresh** volume — an existing `agent_platform_pgdata` keeps
> its old `pg_hba` until you recreate it (`docker compose down -v && docker compose up -d`).

Now the app serves from Postgres. Sessions, transcripts, voice-usage, analysis,
and coach memory persist across restarts. Verify the DB directly:

```bash
docker exec agent_platform_db psql -U agent -d agent_platform -c "select count(*) from scenario;"
```

Tear down (drops all data): `docker compose down -v`.

> Already have Postgres? Skip compose and point `DATABASE_URL` at it — but it
> must have the `vector` extension available (migration 0003 runs
> `CREATE EXTENSION vector`).

### 2. Real OpenAI voice

Provision a key out-of-band (never commit it), then:

```bash
export OPENAI_API_KEY=sk-...
export REALTIME_VENDOR=openai
npm run dev
```

`Join` now runs live OpenAI Realtime through the seam instead of the deterministic
mock; `/api/realtime/token` mints the ephemeral browser secret (returns **501**
when no key is set, which is the correct "not configured" signal). `OPENAI_REALTIME_MODEL`
(default `gpt-realtime`) and `OPENAI_VOICE` (default `alloy`) are optional overrides.

> **Scope note (governance):** this is an *internal / local* smoke with your own
> key — the same posture as the Slice-0 live benchmarking (SAU-176). It is **not**
> a production commitment. Routing **real end-user audio** to OpenAI at scale
> remains gated by the production gates in SAU-193 (unit-economics + DPA/PII),
> which are binding before any launch.

Both together = the full real stack. Combine the exports from §1 and §2 before
`npm run dev`.

Checks: `npm run typecheck` · `npm run lint` · `npm test` (compiler round-trip, CRUD,
voice-session persistence + metering, **auth + RBAC permission tests** — all run
hermetically, no infra; the Postgres RLS test self-skips without `DATABASE_URL`).

## Authentication & RBAC (Slice 5, SAU-229 · [ADR-007](../docs/adr/ADR-007-rbac-roles-and-permissions.md))

Login is required — unauthenticated requests are redirected to `/login` (pages)
or get `401` (API). Auth is email+password behind a provider seam
(`src/auth/provider.ts`) so an org SSO/OIDC provider can replace it without
touching the session/RBAC layers. Sessions are server-side tokens in an httpOnly
cookie (`auth_session`), so logout/expiry are server-enforced.

**Roles are capability bundles, stored as config** (`role_capability`), not
hard-coded. MVP ships two roles the UI gates on (`user`, `admin`); `operator` is
also defined so role differentiation is testable now (B2B surfaces it later).

| Capability | user | operator | admin |
|---|:--:|:--:|:--:|
| `practice`, `author_content` (own) | ✅ | ✅ | ✅ |
| `assign_to_users`, `view_identified_results` | ❌ | ✅ | ✅ |
| `manage_org_members`, `manage_billing`, `platform_admin` | ❌ | ❌ | ✅ |

**Two-layer enforcement:** a capability/ownership guard at the API/route layer
(`src/auth/guard.ts`, `src/auth/api-guard.ts`) **and** Postgres Row-Level Security
(`FORCE`, migration 0005) on `scenario`/`coach`/`course`/`session`, mirroring the
proven `coach_memory` pattern. The app binds the acting user into a request-scoped
context (`src/auth/actor.ts`); `PgStore` sets `app.user_id` / `app.is_admin` per
transaction so the policies scope every row. Public reads (`is_public` /
`course.visibility` / null-owner platform content) keep working for anyone.

### Seeded test users (for QA)

One account per role exists out of the box. **Dev/QA only** — never seed these in
production.

| Email | Password | Role |
|---|---|---|
| `user@demo.test` | `password123` | user |
| `admin@demo.test` | `password123` | admin |
| `operator@demo.test` | `password123` | operator |

- **Zero-infra (in-memory):** these users are auto-seeded on boot — just open the
  app and sign in.
- **Postgres:** `npm run seed` (or `npm run seed:users`) creates them durably.

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
