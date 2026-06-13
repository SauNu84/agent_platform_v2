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
| What is "success"? | A rubric score (0–100) | An appointment **actually created** |
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

## What's live today vs. coming next

- **Today (the platform already has):** real-time voice in the browser (OpenAI / Gemini), persona authoring, the tool-calling framework, and knowledge-base injection.
- **Phase 0 (the spike we're building now):** the \`clinic-intake-booking\` scenario with **real booking tools** and a **sandbox calendar** — talk to it in the browser and watch it create a real event. Synthetic patients only, no real patient data.
- **Phase 1 (next):** real **phone calls** (telephony), a real clinic calendar with sign-in, SMS/email confirmations, and a human hand-off path.
- **Phase 2 (gated):** healthcare-grade hardening (HIPAA program), self-service clinic setup, multi-clinic support.

> **Privacy note:** while this is a demo, it uses **made-up patients only**. Before any real patient data flows through it, our security team scopes the healthcare (HIPAA/PHI) requirements first.
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
  },
];

/** The lightweight shape the nav + hub sidebars need (no Markdown bodies). */
export interface UseCaseLink {
  slug: string;
  title: string;
  navLabel: string;
  icon: string;
}

export function getAllUseCases(): UseCase[] {
  return USE_CASES;
}

export function toUseCaseLinks(): UseCaseLink[] {
  return USE_CASES.map(({ slug, title, navLabel, icon }) => ({ slug, title, navLabel, icon }));
}

export function getUseCase(slug: string): UseCase | null {
  return USE_CASES.find((u) => u.slug === slug) ?? null;
}
