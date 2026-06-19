/**
 * Use Case catalog (SAU-269 — top-level "Use Case" group).
 *
 * Use cases are plain-language explainers of real things this platform can DO
 * (vs. the docs, which explain how to use the product). Like the docs registry
 * (services/docs.ts) they are static, first-party, version-controlled content
 * rendered fully server-side — no DB read. The catalog is built to GROW: add a
 * new entry here (slug + nav metadata + Markdown body) and it appears in the left
 * nav, the /use-cases hub, and gets its own /use-cases/[slug] page automatically.
 *
 * Bodies are GitHub-flavoured Markdown and may contain \`\`\`mermaid fences, which the
 * shared MarkdownDoc renderer turns into real diagrams (see components/MarkdownDoc).
 *
 * Content is authored by the CPO on SAU-265 (use-case-clinic-explainer doc).
 */

/** A nested nav entry under a use case (e.g. the clinic agent's demo setup page). */
export interface UseCaseSubLink {
  href: string;
  label: string;
}

export interface UseCase {
  /** URL slug under /use-cases/[slug]; unique across the catalog. */
  slug: string;
  /** Full title (used for the hub card + page metadata). */
  title: string;
  /** Short label shown in the left-nav submenu. */
  navLabel: string;
  /** Glyph for the nav + hub card. */
  icon: string;
  /** One-line summary for the hub card + meta description. */
  summary: string;
  /** Article body as GFM Markdown (may include \`\`\`mermaid fences). */
  body: string;
  /** Optional nested nav links (e.g. a config sub-page) shown under this entry. */
  subLinks?: UseCaseSubLink[];
}

const CLINIC_AGENT_BODY = `# Use Case — AI Clinic Call Agent (Intake & Booking)

> **What this page is:** a plain-language explainer of one real use case our platform can run — an AI agent that answers a clinic's phone, talks to a patient, collects their information, checks the clinic's calendar and rules, and books an appointment with the right doctor. Use it to understand *what the agent does*, *how the conversation flows*, and *what you get at the end*.

---

## The situation, in one paragraph

A patient calls a clinic to book an appointment. Instead of a human receptionist, an **AI agent** picks up. It greets the patient, asks for the details a clinic needs (name, date of birth, reason for the visit, insurance, preferred times), checks **which doctor is available and when**, applies the **clinic's rules** (opening hours, appointment length, no double-booking), and **creates the appointment** on the clinic's calendar. The patient hangs up with a booked slot; the clinic gets a structured intake record and a confirmed event — no human in the loop for the routine case.

## Why this is different from a practice/training scenario

Most scenarios on this platform are **training simulators**: the AI plays a role, a human practices against it, and we *score the human*. This use case **flips the roles** — the AI does the real work, and a real person is the one being helped.

| | Training scenario (today) | This use case (action agent) |
|---|---|---|
| Who is the AI? | The persona you practice **against** | The receptionist that **does the work** |
| Who is the human? | A learner being scored | A real patient with a real need |
| What is "success"? | A practice score (0–100) | An appointment **actually created** |
| What you get | A report card | A booked slot + intake record + confirmation |

The good news: under the hood, **the clinic agent *is* a scenario** — a persona (warm, efficient receptionist) + a knowledge base (clinic hours, doctors, insurance accepted) + tools (check availability, create appointment) + a goal (intake + book). We reuse everything the platform already does for conversations and add the "action + outcome" layer.

---

## User flow (what happens on the call)

\`\`\`mermaid
flowchart TD
    A([Patient calls the clinic]) --> B[AI agent answers<br/>warm receptionist persona]
    B --> C{Collect intake}
    C --> C1[Name &amp; date of birth]
    C --> C2[Reason for visit]
    C --> C3[Insurance]
    C --> C4[Preferred doctor / times]
    C1 & C2 & C3 & C4 --> D[Agent calls tool:<br/>check_availability]
    D --> E{Open slot that fits<br/>clinic rules?}
    E -- Yes --> F[Agent calls tool:<br/>create_appointment]
    F --> G([Booked ✅<br/>event created + confirmation])
    E -- No suitable slot --> H[Offer nearest alternatives]
    H --> E
    E -- Edge case / patient needs a human --> I([Escalate to clinic staff])
    G --> J[Save structured intake record<br/>+ outcome: booked]
    I --> K[Outcome: escalated]
    H -. none acceptable .-> L[Outcome: no_slot]
\`\`\`

## Behind the scenes (how the pieces talk)

\`\`\`mermaid
sequenceDiagram
    actor P as Patient
    participant AG as AI Agent (voice)
    participant KB as Clinic Knowledge Base
    participant TL as Booking Tools (server)
    participant CAL as Clinic Calendar

    P->>AG: "I'd like to book an appointment"
    AG->>KB: Read clinic hours, doctors, insurance rules
    AG->>P: Ask intake questions (name, DOB, reason, insurance, times)
    P->>AG: Provides details
    AG->>TL: check_availability(doctor?, date range)
    TL->>CAL: Read open slots
    CAL-->>TL: Available slots
    TL-->>AG: Slots that satisfy clinic rules
    AG->>P: Offer a time
    P->>AG: Confirms
    AG->>TL: create_appointment(patient, doctor, slot, reason)
    TL->>CAL: Create event (no double-book)
    CAL-->>TL: Event created (id)
    TL-->>AG: Booked + confirmation
    AG->>P: "You're booked for Tue 10:00 with Dr. Lee 👍"
    Note over AG,TL: Outcome recorded: booked / no_slot / escalated<br/>Structured intake saved alongside the session
\`\`\`

---

## What you get at the end

- **A real calendar event** on the clinic's calendar (the proof the task was completed).
- **A structured intake record** — the patient's details captured as clean, validated data (not just a transcript).
- **An outcome status** — \`booked\`, \`no_slot\` (offered alternatives, none worked), or \`escalated\` (handed to a human).

## What's live today

- **Real-time voice** in the browser and over the phone (telephony bridge), persona authoring, the tool-calling framework, and knowledge-base injection.
- **Real booking** against a connected clinic calendar (Google Calendar sign-in) — talk to the agent and watch it create a real event.
- **SMS / email confirmations** and a **human hand-off** path for anything the agent shouldn't handle alone.
- **Self-service clinic setup** and **multi-clinic** support, each clinic fully isolated, with an ops dashboard for outcomes and ROI.

> **Privacy by design.** Patient data is encrypted at rest, every access is audited, and no real patient is called until the clinic's HIPAA program is signed off. Demos run on test data only — compliance is enforced in the system, not promised in a prompt.
`;

// SAU-329 (parent SAU-328): second use case. CPO-authored explainer for an
// outbound, compliant collections call agent. Pure catalog addition — content
// only; the compliance engine / dialer are a later phase gated on Legal scoping.
const COLLECTIONS_AGENT_BODY = `# Use Case — AI Call Center Agent for Collections (compliant reminders)

> **What this page is:** a plain-language explainer of a second real use case — an AI agent that makes **outbound reminder calls** to a lender's debtors, strictly inside the rules that keep outreach respectful and compliant. Where the Clinic Agent *answers* calls and books, this agent *places* calls and reminds — within hard guardrails.

---

## The situation, in one paragraph

A bank or lender has a list of customers with upcoming or overdue payments. Instead of a room full of agents dialing manually, an **AI agent** calls each debtor — but only when it's allowed: **business hours (e.g. 9 AM–5 PM) on working days**, **no more than once every two weeks** per person, never on weekends or holidays, and it stops the moment someone asks. On the call it identifies itself, gives the required disclosures, reminds the customer of the amount and due date, offers to help (pay now, set a plan, talk to a human), records the outcome, and schedules the next allowed contact. The lender gets timely, consistent, **fully logged and compliant** outreach.

## Why the rules ARE the product

Collections is one of the most regulated kinds of calling there is. The value here isn't "call more people" — it's **"call correctly, every time, provably."** So the company's rules are not suggestions in a prompt; they're **hard guardrails enforced in the system**, and the agent literally cannot break them:

| Rule | How it's enforced |
|---|---|
| Call only 9 AM–5 PM, working days | Calling-window gate in the scheduler — out-of-window calls are never placed |
| At most once / 2 weeks per debtor | Frequency cap per contact, tracked server-side |
| No weekends / holidays | Calendar-aware scheduler |
| Honor "stop calling" / disputes | Do-not-call + opt-out list, checked before every call |
| Required identification & disclosures | Built into the script the agent must follow |
| Full audit trail | Every attempt, outcome, and consent state logged |

## How it compares to the Clinic Agent

| | Clinic Agent | Collections Agent |
|---|---|---|
| Direction | **Inbound** (patient calls in) | **Outbound** (agent calls debtor) |
| Trigger | A ringing phone | A debtor list + an *allowed* time slot |
| Core constraint | Clinic hours / calendar | Compliance: calling window, frequency cap, do-not-call |
| Goal | Book an appointment | A compliant reminder + recorded outcome / next step |
| Shared foundation | Same voice, telephony bridge, tool-calling, outcome model, multi-tenant config | ← reused |

---

## User flow (one debtor, one cycle)

\`\`\`mermaid
flowchart TD
    A([Lender uploads debtor list]) --> B[Scheduler picks who is due]
    B --> C{Allowed to call now?}
    C -- "Outside 9-5 / weekend / holiday" --> Z1[Wait for next allowed window]
    C -- "Called within last 2 weeks" --> Z2[Hold until cadence allows]
    C -- "On do-not-call / opted out" --> Z3[Skip - never call]
    C -- Yes, all clear --> D[Agent places the call]
    D --> E[Identify + required disclosures]
    E --> F{Reach the person?}
    F -- No answer / voicemail --> G[Log attempt - reschedule next allowed slot]
    F -- Yes --> H[Remind: amount, due date]
    H --> I{Customer response}
    I -- Pay now / set plan --> J([Outcome: arrangement made])
    I -- Wants a human --> K([Warm transfer / callback])
    I -- "Stop calling" / dispute --> L([Add to do-not-call - stop])
    G & J & K & L --> M[Record outcome + schedule next allowed contact]
\`\`\`

---

## What's live today
- **Compliance engine + cadence scheduler** — calling-window, frequency-cap, do-not-call and holiday guardrails enforced server-side. The engine refuses any dial it isn't allowed to place.
- **Debtor-list ingestion** with validation, and **outbound dialing** with voicemail handling.
- **Required disclosures & opt-out** handling, plus a read-only, append-only **compliance audit trail** — why each debtor was or wasn't called.
- **Per-lender rule authoring, multi-tenant isolation and an ops dashboard** for cadence, suppression and compliance reporting.

## The compliance posture
This is a **compliant-by-design** outreach tool — FDCPA, TCPA and Reg F rules are enforced guardrails in the system, not optional prompt instructions. Every attempt, outcome and consent state is logged. No real debtor is called until the lender's compliance program is signed off; demos run on test data only.
`;

export const USE_CASES: UseCase[] = [
  {
    slug: "clinic-agent",
    title: "AI Clinic Call Agent (Intake & Booking)",
    navLabel: "AI Clinic Agent",
    icon: "🏥",
    summary:
      "An AI agent answers a clinic\u2019s phone, collects patient intake, checks the calendar and clinic rules, and books the appointment \u2014 a real action-taking agent, not a training sim.",
    body: CLINIC_AGENT_BODY,
    // SAU-297: no-code demo setup (connect Google Calendar + phone numbers) as a
    // left-nav sub-item under the clinic agent, not just an in-page button.
    subLinks: [
      { href: "/use-cases/clinic-agent/configure", label: "Set up a demo" },
      // SAU-301 WS-B: per-clinic ops dashboard (outcomes/ROI) + clinic switcher.
      { href: "/use-cases/clinic-agent/dashboard", label: "Ops dashboard" },
    ],
  },
  // SAU-329: second use case, listed below the clinic agent in the nav. Content/UX
  // only — the explainer page; the compliance engine / dialer are a later phase
  // gated on Legal/Compliance scoping (no real debtor is called from this page).
  {
    slug: "call-center-agent",
    title: "AI Call Center Agent for Collections (Compliant Reminders)",
    navLabel: "AI Call Center Agent",
    icon: "☎️",
    summary:
      "An AI agent places outbound payment-reminder calls to a lender’s debtors — strictly inside hard compliance guardrails (calling window, frequency cap, do-not-call), fully logged. Compliant outbound payment reminders.",
    body: COLLECTIONS_AGENT_BODY,
    // SAU-335 WS-4: per-lender ops dashboard — cadence/next-eligible dial, suppression
    // list, compliance-block counts + the read-only guardrail-10 audit trail.
    subLinks: [
      { href: "/use-cases/call-center-agent/dashboard", label: "Ops dashboard" },
    ],
  },
];

/** The lightweight shape the nav + hub sidebars need (no Markdown bodies). */
export interface UseCaseLink {
  slug: string;
  title: string;
  navLabel: string;
  icon: string;
  subLinks?: UseCaseSubLink[];
}

export function getAllUseCases(): UseCase[] {
  return USE_CASES;
}

export function toUseCaseLinks(): UseCaseLink[] {
  return USE_CASES.map(({ slug, title, navLabel, icon, subLinks }) => ({ slug, title, navLabel, icon, subLinks }));
}

export function getUseCase(slug: string): UseCase | null {
  return USE_CASES.find((u) => u.slug === slug) ?? null;
}
