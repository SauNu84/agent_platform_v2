/**
 * Universal session view — renders one completed voice session as a chat transcript.
 * Reached after clicking Join on any scenario or coach detail page.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getStore } from '@/db';

export const dynamic = 'force-dynamic';

export default async function SessionPage({ params }: { params: { id: string } }) {
  const store = getStore();
  const session = await store.getSession(params.id);
  if (!session) notFound();

  // Resolve entity name + back link from whichever entity owns this session.
  let entityName = 'Session';
  let backHref = '/library';
  let backLabel = 'Back to Library';

  if (session.scenarioId) {
    const scenario = await store.getScenarioById(session.scenarioId);
    if (scenario) {
      entityName = scenario.name;
      backHref = `/scenarios/${scenario.slug}`;
      backLabel = scenario.name;
    }
  } else if (session.coachId) {
    const coach = await store.getCoachById(session.coachId);
    if (coach) {
      entityName = coach.name;
      backHref = `/coaches/${coach.slug}`;
      backLabel = coach.name;
    }
  }

  const turns = session.transcript?.turns ?? [];
  const duration =
    session.endedAt && session.startedAt
      ? Math.round((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000)
      : null;

  return (
    <div className="session-view">
      <nav className="session-nav">
        <Link href={backHref} className="back-link">← {backLabel}</Link>
        <span className="session-meta">
          {new Date(session.startedAt).toLocaleString()} · {turns.length} turn{turns.length === 1 ? '' : 's'}
          {duration !== null ? ` · ${duration}s` : ''}
          {session.vendor === 'mock' ? ' · mock mode' : ` · ${session.vendor}`}
        </span>
      </nav>

      <h1 className="session-title">{entityName}</h1>
      <p className="subtitle">Practice session</p>

      {turns.length === 0 ? (
        <div className="session-empty">
          <p>No transcript recorded for this session.</p>
          <Link href={backHref} className="btn">Practice again</Link>
        </div>
      ) : (
        <div className="conversation">
          {turns.map((turn, i) => (
            <div key={i} className={`turn turn-${turn.role}`}>
              <span className="turn-role">{turn.role === 'agent' ? 'AI' : 'You'}</span>
              <div className="turn-text">{turn.text}</div>
            </div>
          ))}
        </div>
      )}

      <div className="session-actions">
        <Link href={backHref} className="btn">Practice again</Link>
        <Link href="/history" className="btn-ghost">View all sessions</Link>
      </div>
    </div>
  );
}
