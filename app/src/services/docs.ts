/**
 * Documentation registry (SAU-251 — Resources › Documentation).
 *
 * Product docs are static, first-party content — not per-user entities — so they
 * live here as a typed registry of Markdown articles grouped into sections rather
 * than in Postgres. This keeps them version-controlled alongside the code they
 * describe and lets the /docs pages render fully server-side with no DB read.
 *
 * The content is ORIGINAL and grounded in this platform's real features (we do
 * not copy competitor docs — see the SAU-245/234 IP lesson). When the API or a
 * feature changes, update the relevant article body here so the docs stay true
 * (per the board's "keep the docs updated" ask on SAU-251).
 */

export interface DocArticle {
  /** URL slug under /docs/[slug]; unique across the whole registry. */
  slug: string;
  title: string;
  /** One-line summary shown on the Documentation home cards + meta description. */
  summary: string;
  /** Article body as GitHub-flavoured Markdown. */
  body: string;
}

export interface DocSection {
  id: string;
  title: string;
  articles: DocArticle[];
}

/** The lightweight shape the docs sidebar needs (no Markdown bodies). */
export interface SidebarSection {
  id: string;
  title: string;
  articles: { slug: string; title: string }[];
}

export const DOC_SECTIONS: DocSection[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    articles: [
      {
        slug: 'introduction',
        title: 'Introduction',
        summary: 'What Agent Platform is and how practising with an AI roleplay partner works.',
        body: `# Introduction

Agent Platform lets you **practise high-stakes conversations** against a realistic
AI roleplay partner — a tough customer, a skeptical hiring panel, a direct report
who needs feedback — and get scored on how you did.

Every practice partner is a **scenario**: a persona, a situation, and a scoring
rubric. You can practise a scenario by **text chat** or by **live voice**, review
a structured breakdown of your performance, and come back to improve.

## Why practise here

- **Safe reps.** Rehearse the conversation that matters before it happens for real.
- **Specific feedback.** Each session is scored against a rubric, not a vibe.
- **Repeatable.** Run the same scenario as many times as you want and watch your
  scores move.

## The building blocks

| Concept | What it is |
| --- | --- |
| **Scenario** | A single roleplay partner — persona + situation + rubric. |
| **Course** | An ordered track of scenarios you work through in sequence. |
| **Coach** | A scenario that *remembers you* across sessions and follows a cadence. |
| **Session** | One recorded attempt at a scenario, scored afterwards. |

Next: [Quick start](/docs/quick-start) walks you through your first session in a
couple of minutes.`,
      },
      {
        slug: 'quick-start',
        title: 'Quick start',
        summary: 'Run your first practice session end to end in a few minutes.',
        body: `# Quick start

This is the fastest path from signing in to your first scored session.

## 1. Open the Scenario Library

From the left rail, choose **Scenarios**. The **Featured** tab lists ready-made
scenarios across product, engineering, leadership, sales, and business topics.
Use the search box to narrow the list.

## 2. Pick a scenario

Click any card to open its detail page. You'll see an **Overview**, a
**Your Instructions** briefing (what you're walking into and what good looks
like), and the actions available for that scenario.

## 3. Practise — chat or voice

- **💬 Chat** — type back and forth with the persona. Great for a quick rep.
- **🎙 Live demo** — talk out loud; the partner replies in voice.

## 4. Review your performance

When you end the session it's saved to your **History**. Open it (or run
**Analyze**) to see a scored breakdown against the scenario's rubric, with
strengths and concrete things to improve.

## 5. Run it again

Practice is reps. Re-run the same scenario and watch your scores move on the
**Analytics** page.

> Want to make your own partner instead? See [Creating a scenario](/docs/creating-a-scenario).`,
      },
      {
        slug: 'core-concepts',
        title: 'Core concepts',
        summary: 'Scenarios, courses, coaches, and sessions — and how they fit together.',
        body: `# Core concepts

A quick mental model so the rest of the docs make sense.

## Scenario

The atom of the platform. A scenario bundles:

- a **persona** (who you're talking to and how they behave),
- a **situation / instructions** (the setup and your goal), and
- a **rubric** (the criteria you're scored against).

You practise a scenario by chat or voice. See
[Creating a scenario](/docs/creating-a-scenario).

## Course

A **course** is an ordered list of scenarios — a track you work through in
sequence, with progress tracked as you complete each step. Use it to string
individual reps into a curriculum. See [Courses](/docs/courses).

## Coach

A **coach** is a scenario that **remembers you** between sessions and runs on a
**cadence**. Where a plain scenario starts fresh each time, a coach carries
forward what it learned about you so each session builds on the last. See
[Coaches](/docs/coaches).

## Session

A **session** is one recorded attempt at a scenario. Chat and voice both produce
sessions. A session can be **analyzed** to produce a score and feedback, and it
shows up in your **History** and **Analytics**. Voice sessions consume voice
minutes; chat sessions do not (see [Usage & billing](/docs/usage-and-billing)).`,
      },
    ],
  },
  {
    id: 'practising',
    title: 'Practising',
    articles: [
      {
        slug: 'chat-practice',
        title: 'Chat practice',
        summary: 'Practise a scenario by typing — fast, free, and available anywhere.',
        body: `# Chat practice

Chat practice lets you rehearse a scenario as a **text conversation**. The persona
replies in character based on the scenario's instructions and rubric.

## How to start

1. Open a scenario from the **Scenarios** library.
2. Click **💬 Chat**.
3. Type your opening and go — the partner responds in role.

## Good to know

- **Not metered.** Chat sessions don't consume voice minutes, so you can do as
  many reps as you like.
- **Saved as a session.** Every chat conversation is recorded as a session, so it
  appears in your [History](/docs/sessions-and-history) and can be analyzed.
- **Same rubric.** Chat is scored against the same rubric as voice — it's a
  lower-friction way to practise the substance of the conversation.

For talking out loud, see [Live voice practice](/docs/live-voice-practice).`,
      },
      {
        slug: 'live-voice-practice',
        title: 'Live voice practice',
        summary: 'Talk out loud in real time and hear the partner respond in voice.',
        body: `# Live voice practice

Live voice practice is the closest thing to the real conversation: you speak, the
partner listens and replies out loud, in real time.

## Before you start

The browser will ask for **microphone** (and optionally camera) access. We verify
your mic and camera are working before the session begins so you're not caught out
mid-conversation.

## Running a session

1. Open a scenario and click **🎙 Live demo**.
2. Grant microphone access when prompted.
3. Speak naturally — the live window shows a timer, the partner, your instructions,
   session controls, and a running transcript.
4. End the session when you're done; it's saved to your History.

## Good to know

- **Metered.** Voice sessions consume **voice minutes** from your plan. Track your
  balance in the left rail and on the [Usage & billing](/docs/usage-and-billing)
  page.
- **Transcript.** The conversation transcript is captured so you can review and
  analyze it afterwards, exactly like a chat session.`,
      },
      {
        slug: 'reviewing-performance',
        title: 'Reviewing your performance',
        summary: 'How sessions are scored, and where to see strengths and areas to improve.',
        body: `# Reviewing your performance

Every session can be turned into a **structured analysis**: a score against the
scenario's rubric plus specific, actionable feedback.

## Analyzing a session

- After a session ends, open it from your [History](/docs/sessions-and-history)
  and run **Analyze**, or analyze in bulk from the History page.
- The analysis evaluates your transcript against each rubric criterion and
  summarises what went well and what to work on.

## Reading the breakdown

A typical analysis includes:

- an **overall result** for the session,
- a **per-criterion** view tied to the rubric, and
- concrete **suggestions** for your next attempt.

## Tracking progress over time

The **Analytics** page aggregates across your sessions so you can see trends —
which scenarios you've practised, how often, and how your scores are moving. The
goal is reps with feedback, so come back and run the scenario again.

See also: [Rubrics & scoring](/docs/rubrics-and-scoring).`,
      },
    ],
  },
  {
    id: 'building',
    title: 'Building your own',
    articles: [
      {
        slug: 'creating-a-scenario',
        title: 'Creating a scenario',
        summary: 'Build your own roleplay partner with the guided four-tab scenario form.',
        body: `# Creating a scenario

You're not limited to the featured library — build your own practice partner for
the exact conversation you need to rehearse.

## Where to start

Go to **Scenarios → My Scenarios** and click **+ Create new scenario**. You can
build with the **Classic form** or with **AI Studio** (a copilot that drafts the
scenario for you — see [AI Studio](/docs/ai-studio)).

## The four tabs

The Classic form groups settings by intent so you only think about one thing at
a time:

| Tab | What you set |
| --- | --- |
| **Basics** | Name, category, the learner-facing overview and instructions. |
| **AI Agent** | The persona's behaviour, system guidance, and any linked Knowledge Base. |
| **Session & Scoring** | The rubric (your scoring criteria) and session settings. |
| **Voice & Look** | Voice selection and presentation. |

## Publishing

When you save, the scenario is compiled and validated before it goes live, so a
broken scenario can't be published. New scenarios are **private to you** and show
up under **My Scenarios**; you choose when to make one public.

## Faster ways to build

- **[AI Studio](/docs/ai-studio)** — describe what you want and let the copilot
  draft it.
- **Remix** — start from an existing scenario and clone it into an editable draft
  of your own.

Next: [Rubrics & scoring](/docs/rubrics-and-scoring) and
[Knowledge Base](/docs/knowledge-base).`,
      },
      {
        slug: 'ai-studio',
        title: 'AI Studio',
        summary: 'Draft a scenario with an AI copilot instead of filling in the form by hand.',
        body: `# AI Studio

AI Studio is a copilot mode for authoring scenarios. Describe the conversation you
want to practise and it drafts the persona, instructions, and rubric for you — then
you refine the result in the same four-tab form.

## Classic ⇄ AI Studio

The create screen has a toggle between the **Classic form** and **AI Studio**. They
edit the *same* scenario, so you can start in AI Studio, then switch to Classic to
fine-tune any field — or vice versa.

## Effort levels

AI Studio offers two drafting modes:

- **Flash** — fast drafts, ideal for quick iteration.
- **Deep** — slower, more thorough drafting for complex scenarios.

## How it's kept safe

The copilot proposes content into the form — it **never writes to the database
directly**. Whatever it drafts still passes through the same compile-and-validate
gate as a hand-built scenario before you publish. You're always the final editor.

See [Creating a scenario](/docs/creating-a-scenario) for the form itself.`,
      },
      {
        slug: 'rubrics-and-scoring',
        title: 'Rubrics & scoring',
        summary: 'Define the criteria a session is judged against, and how scoring works.',
        body: `# Rubrics & scoring

A **rubric** is the set of criteria a scenario is scored against. It's what turns a
roleplay into measurable practice.

## Authoring a rubric

On the **Session & Scoring** tab of the scenario form, the rubric has two views:

- **Edit** — write your criteria as free text, the way you'd brief a human coach.
- **Processed** — the AI parses your free text into structured criteria so they can
  be scored consistently.

You can move between the two — write naturally, then process it into structure.

## How scoring uses it

When a session is [analyzed](/docs/reviewing-performance), the transcript is
evaluated against each rubric criterion. Clear, specific criteria produce clearer,
more useful feedback — so spell out what *good* looks like for the conversation.

## Tips for good rubrics

- Make each criterion **observable** ("acknowledges the objection before
  answering") rather than vague ("good communication").
- Keep the list **focused** — a handful of criteria that matter beats twenty that
  don't.
- Describe the **behaviour**, not the outcome, where you can.`,
      },
      {
        slug: 'knowledge-base',
        title: 'Knowledge Base',
        summary: 'Upload reference documents once and link them into any scenario.',
        body: `# Knowledge Base

The **Knowledge Base** lets you upload reference material once and link it into
many scenarios, so the persona can ground its responses in *your* documents — a
product spec, a pricing sheet, a policy doc.

## Supported files

You can upload **.pdf**, **.docx**, and **.txt** documents. Their text is extracted
and stored so it can be folded into a conversation.

## Linking documents to a scenario

On the **AI Agent** tab of the scenario form, link one or more Knowledge Base
documents. When you practise, the linked content is injected into the persona's
context for both **chat** and **voice** sessions, within a generous character
budget.

## Upload once, reuse everywhere

The Knowledge Base is deliberately separate from a scenario's inline "additional
context": upload a document a single time and link it into as many scenarios as you
like, instead of pasting the same text repeatedly.`,
      },
      {
        slug: 'courses',
        title: 'Courses',
        summary: 'Group scenarios into an ordered track and follow your progress.',
        body: `# Courses

A **course** is an ordered track of scenarios — a curriculum you work through in
sequence rather than picking scenarios one at a time.

## Using a course

Open **Course** from the left rail. The **Featured** tab lists ready-made tracks
(role-based paths across product, engineering, leadership, sales, and business);
**My Courses** lists tracks you've created.

Inside a course you can **play through the scenarios in order**, and your
**progress** is tracked as you complete each step.

## Creating a course

From **My Courses**, click **+ Create new course**. You give it a name, a cover
image (or let a generated cover stand in), and an ordered list of scenarios. The
course validates that every scenario it references actually exists before it saves.

## When to use a course vs a coach

- Use a **course** to sequence *different* scenarios into a path.
- Use a **[coach](/docs/coaches)** when you want *one* partner that remembers you
  and works with you over time.`,
      },
      {
        slug: 'coaches',
        title: 'Coaches',
        summary: 'A practice partner that remembers you across sessions and follows a cadence.',
        body: `# Coaches

A **coach** is a scenario with a memory. Where a plain scenario starts fresh every
time, a coach **carries forward what it learned about you** between sessions and
runs on a **cadence**, so each session builds on the last.

## Using a coach

Open **Coach** from the left rail. Browse **Featured** coaches by topic or your own
under **My** coaches, open one to see its value and your progress, and start a
session. Over repeated sessions the coach references prior context to push you
further.

## Memory & privacy

Coach memory is **derived from your sessions** and exists to make coaching better.
It's designed with privacy in mind:

- you can review what a coach has retained,
- you control consent, and
- you can request deletion of your data.

These controls live in the coach's **Memory & privacy** section.

## Coaches vs scenarios

- A **scenario** is a clean rep — no memory carried over.
- A **coach** is a relationship — it remembers and adapts. See
  [Core concepts](/docs/core-concepts).`,
      },
    ],
  },
  {
    id: 'account',
    title: 'Account',
    articles: [
      {
        slug: 'usage-and-billing',
        title: 'Usage & billing',
        summary: 'Plans, voice minutes, overage, and where to track your balance.',
        body: `# Usage & billing

Voice practice is metered in **voice minutes**. Chat practice is free and
unmetered. Manage all of this from the **Billing** page (pinned to the bottom of
the left rail).

## Plans

| Plan | Best for |
| --- | --- |
| **Free** | Trying the platform and unlimited chat practice. |
| **Standard** | Regular voice practice with a monthly minute allowance. |
| **Premium** | Heavy voice usage with the largest allowance. |

Paid plans can be billed **monthly** or **annually** (annual works out cheaper per
month). Upgrade from the **Subscription plan** card on the Billing page.

## Voice minutes & overage

- Your plan includes a monthly **minute allowance**.
- Your **wallet balance** (minutes left this cycle) is always visible in the left
  rail and on the Billing page.
- If you run out mid-cycle, starting a new voice session is blocked until you
  upgrade or your allowance renews; usage beyond the cap is handled as overage per
  your plan.

## Tracking usage

The Billing page shows your **usage statistics** (total sessions, minutes used,
minutes remaining), a **usage history** of recent sessions and the minutes they
consumed, and your **purchase** history.`,
      },
      {
        slug: 'sessions-and-history',
        title: 'Sessions & history',
        summary: 'Find past sessions, analyze them, restore, or export to CSV.',
        body: `# Sessions & history

Every chat and voice attempt is saved as a **session**. The **History** page (under
the **Sessions** group in the left rail) is where you find and act on them.

## What you can do from History

- **Analyze** — score a session against its rubric and see feedback (see
  [Reviewing your performance](/docs/reviewing-performance)). You can analyze
  individually or in bulk.
- **Restore** — reopen a past session's detail.
- **Export CSV** — download your session history for your own records or analysis.

## Analytics

The **Analytics** page rolls your sessions up into trends — what you've practised,
how often, and how your scores are changing over time. Use History to dig into a
single attempt and Analytics to see the bigger picture.`,
      },
    ],
  },
];

/** Strip the registry down to the lightweight shape the sidebar renders. */
export function toSidebarSections(sections: DocSection[] = DOC_SECTIONS): SidebarSection[] {
  return sections.map((s) => ({
    id: s.id,
    title: s.title,
    articles: s.articles.map((a) => ({ slug: a.slug, title: a.title })),
  }));
}

/** Flat list of every article, in section order. */
export function getAllArticles(): DocArticle[] {
  return DOC_SECTIONS.flatMap((s) => s.articles);
}

/** Resolve a single article by slug (null if unknown). */
export function getArticle(slug: string): DocArticle | null {
  return getAllArticles().find((a) => a.slug === slug) ?? null;
}

/** The first article — the landing target when you open Documentation. */
export function firstArticleSlug(): string {
  return getAllArticles()[0].slug;
}

/** Previous/next articles for in-page navigation (null at the ends). */
export function getAdjacent(slug: string): { prev: DocArticle | null; next: DocArticle | null } {
  const all = getAllArticles();
  const i = all.findIndex((a) => a.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return { prev: all[i - 1] ?? null, next: all[i + 1] ?? null };
}
