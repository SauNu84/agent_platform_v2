/**
 * POC home — the product front door (SAU-214).
 *
 * Replaces the bare redirect-to-/library with an overview that frames the MVP
 * for a first-time viewer: what the product is, the live capabilities shipped
 * across Slices 1–4 (SAU-210), and a direct entry point into each. Counts are
 * read live from the store so the landing reflects the seeded demo content with
 * zero infra. Server component — no client JS.
 */
import Link from 'next/link';
import { getStore } from '@/db';

export const dynamic = 'force-dynamic';

type Counts = { scenarios: number; courses: number; coaches: number };

type Capability = {
  href: string;
  title: string;
  blurb: string;
  count: (c: Counts) => string;
};

const CAPABILITIES: Capability[] = [
  {
    href: '/library',
    title: 'Scenarios',
    blurb: 'Hyper-realistic AI voice roleplay to practice one high-stakes conversation. Author as Markdown, run live, get a transcript.',
    count: (c) => `${c.scenarios} live`,
  },
  {
    href: '/courses',
    title: 'Courses',
    blurb: 'Ordered sequences of scenarios with Play-All and per-user progress — a guided curriculum, not a single drill.',
    count: (c) => `${c.courses} live`,
  },
  {
    href: '/coaches',
    title: 'Coaches',
    blurb: 'An AI coach that remembers every session, adapts to you, and tracks your progress over time — practice on a recurring cadence, not just once.',
    count: (c) => `${c.coaches} live`,
  },
  {
    href: '/analytics',
    title: 'Analytics',
    blurb: 'Creator analytics across sessions — engagement, scoring, and voice-minute consumption projected from the event log.',
    count: () => 'live',
  },
  {
    href: '/history',
    title: 'History',
    blurb: 'Every session a learner has run: re-analyze, restore, or export to CSV. Backed by a credit / voice-minute meter.',
    count: () => 'live',
  },
];

export default async function Home() {
  const store = getStore();
  let counts: Counts = { scenarios: 0, courses: 0, coaches: 0 };
  // Fail-soft: a store hiccup must never break the front door.
  try {
    const [scenarios, courses, coaches] = await Promise.all([
      store.listScenarios(),
      store.listCourses(),
      store.listCoaches(),
    ]);
    counts = { scenarios: scenarios.length, courses: courses.length, coaches: coaches.length };
  } catch {
    /* keep zeros */
  }

  return (
    <div className="poc-home">
      <header className="hero">
        <span className="badge">MVP · Proof of Concept</span>
        <h1>Practice the conversations that actually matter.</h1>
        <p className="subtitle">
          Hyper-realistic AI voice roleplay for high-stakes conversations — sales objections, stakeholder
          pushback, system-design interviews. Author a scenario in Markdown, talk to it live, and get a scored
          transcript back. Compose scenarios into courses and persistent coaches.
        </p>
        <div className="hero-cta">
          <Link href="/library" className="btn join">Browse Scenarios</Link>
          <Link href="/courses" className="btn-sm">View a Course</Link>
        </div>
      </header>

      <h2>What&apos;s live in this POC</h2>
      <div className="grid">
        {CAPABILITIES.map((cap) => (
          <Link key={cap.href} href={cap.href} className="card">
            <h3>{cap.title}</h3>
            <p>{cap.blurb}</p>
            <div className="badges">
              <span className="badge public">{cap.count(counts)}</span>
            </div>
          </Link>
        ))}
      </div>

      <p className="notice">
        Demo runs on an in-memory store seeded from <code>content/</code> — zero infra required. Voice uses the
        OpenAI Realtime adapter behind a seam; with no live key the Join flow runs in mock mode. Set{' '}
        <code>DATABASE_URL</code> for durable Postgres.
      </p>
    </div>
  );
}
