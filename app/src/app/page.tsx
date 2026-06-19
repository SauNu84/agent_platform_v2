/**
 * Product home — the in-app front door.
 *
 * Frames Proviso for a first-time viewer: what the product does, the flagship
 * action-taking agents, and the practice studio — each a direct entry point.
 * Counts are read live from the store so the home reflects real content. Server
 * component — no client JS.
 */
import Link from 'next/link';
import { getStore } from '@/db';
import { getAllUseCases } from '@/services/use-cases';

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
    blurb: 'Analytics across sessions — engagement, scoring, and voice-minute consumption projected from the event log.',
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

  const useCases = getAllUseCases();

  return (
    <div className="poc-home">
      <header className="hero">
        <h1>AI agents that take action — and stay compliant.</h1>
        <p className="subtitle">
          Proviso ships action-taking AI agents across voice, text, and SMS for regulated,
          high-stakes operations — with guardrails enforced in code and audited, not promised in a
          prompt. Plus a practice studio to author and rehearse the conversations that matter.
        </p>
        <div className="hero-cta">
          <Link href="/use-cases" className="btn join">Explore agents</Link>
          <Link href="/library" className="btn-sm">Browse scenarios</Link>
        </div>
      </header>

      <h2>AI agents</h2>
      <div className="grid">
        {useCases.map((u) => (
          <Link key={u.slug} href={`/use-cases/${u.slug}`} className="card">
            <h3>
              <span aria-hidden="true">{u.icon}</span> {u.title}
            </h3>
            <p>{u.summary}</p>
          </Link>
        ))}
      </div>

      <h2>Practice &amp; coaching</h2>
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
    </div>
  );
}
