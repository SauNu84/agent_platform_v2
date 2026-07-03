# Proviso — Compliance-grade Agent Framework

Proviso builds AI agents for regulated, high-stakes phone and messaging work,
where **compliance-by-construction** is the product, not a checkbox. The wedge:
in markets like healthcare intake and debt collections, the hard part isn't
sounding human — it's never breaking a rule. Proviso puts the guardrails in the
server-side execution seam so an agent *cannot* dial outside legal hours,
disclose PHI it shouldn't, or exceed contact-frequency caps.

> Naming: the product brand is **Proviso** (master brand; verticals read
> "Proviso for Clinics" / "Proviso for Collections"). Some code, issue IDs
> (`SAU-###`), and older docs predate the rename — treat **Proviso** as canonical
> in user-facing copy.

## What's built today

| Archetype | What it does | Status |
|---|---|---|
| **Clinic Secretary** | Inbound patient intake, scheduling into a connected Google Calendar, after-hours handling — over voice + SMS/text. Self-service, no-code clinic setup and multi-clinic tenancy. | Shipped (synthetic + live-call proven) |
| **Collections / Call-Center agent** | Outbound compliant payment-reminder calls. FDCPA / TCPA / Reg-F guardrails (7-in-7 cap, 9–5 local-time windows, do-not-call, limited-content voicemail) enforced server-side and fail-closed. | Shipped synthetic-only; first real call gated on go-live checklist (SAU-331) |

Cross-cutting platform capabilities:

- **Agent Framework core** — the Scenario is the core primitive
  ([ADR-001](docs/adr/ADR-001-scenario-as-core-primitive.md)); Coaches, Courses,
  Analytics, and live voice all compose over it. Content-as-code
  ([ADR-002](docs/adr/ADR-002-content-as-code.md)).
- **Super Agent** — a supervisor agent type orchestrating inline sub-agents,
  with prompt-size and tool-scoping guardrails.
- **Live voice** — OpenAI Realtime over a Twilio telephony bridge (build-vs-buy:
  [ADR-003](docs/adr/ADR-003-realtime-voice-build-vs-buy.md)); in-app Twilio +
  Google-OAuth configuration on the Settings screen.
- **Multi-tenancy + data protection** — Postgres row-level security (RLS) with a
  restricted `app_rw` role, PHI/PII encryption at rest
  ([SAU-274](docs/SAU-274-phi-encryption-at-rest.md)), and append-only HMAC audit
  ledgers. RBAC roles ([ADR-007](docs/adr/ADR-007-rbac-roles-and-permissions.md)).
- **Product analytics** — a PII-free product-event taxonomy and CMO read-models
  (funnel / activation / retention)
  ([framework doc](docs/SAU-350-product-analytics-framework.md)).
- **Marketing site** — a public `/proviso` landing page positioned on the
  compliance wedge with a sales-led design-partner CTA.

## Repository layout

```
app/          Next.js application (the product). See app/README.md to run it.
  src/domain/     Business logic: clinic, collections, super-agent, analytics events
  src/services/   Adapters: calendar, telephony, settings, docs, use-cases, funnel
  src/app/        Routes: /use-cases/*, /proviso, /settings, /docs, /developer-tools
  src/telephony/  Twilio ↔ OpenAI Realtime bridge (npm run bridge)
  src/db/         Migrations, seeds, RLS, retention/purge CLIs
  tests/          node:test suites (npm test)
  scripts/        Proof harnesses (e.g. collections compliance case study)
docs/         Architecture (C4, ERD), ADRs, PRDs, compliance boundaries, runbooks
PLAN.md       Current status and next steps (start here for "what's going on")
```

## Run it

The application lives in `app/`. It degrades gracefully — with no `DATABASE_URL`
or model keys it boots on an in-memory store with seeded demo data, so you can
run it with zero infra:

```bash
cd app
npm install
npm run dev
```

For real Postgres + OpenAI + telephony, see **[`app/README.md`](app/README.md)**
(the durable-store, two-role RLS, and live-voice setup are documented there).

Common gates:

```bash
cd app
npm run typecheck      # tsc --noEmit
npm test               # node:test suites
npm run build          # production build (needs SETTINGS_ENCRYPTION_KEY set)
```

## Compliance posture

Regulated features ship **synthetic-first**. A real outbound collections call is
never placed until the go-live checklist and Legal sign-off in
[SAU-330 compliance boundary](docs/SAU-330-collections-compliance-boundary.md)
are all-green (tracked by gate SAU-331). Clinic PHI handling follows the CISO
privacy review ([ADR-004](docs/adr/ADR-004-CISO-privacy-review.md)) with
encryption at rest and auto-deletion retention
([SAU-285](docs/SAU-285-phi-retention-auto-deletion.md)).

## Where to go next

- **Status & roadmap:** [PLAN.md](PLAN.md)
- **Architecture:** [docs/architecture/C4-container.md](docs/architecture/C4-container.md),
  [docs/architecture/ERD.md](docs/architecture/ERD.md)
- **Decisions:** [docs/adr/](docs/adr/)
- **Running the app:** [app/README.md](app/README.md)
