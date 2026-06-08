'use client';

/**
 * Course player (level 1): ordered scenario list with progress, per-item Start,
 * and Play All (runs each item in sequence). Starting an item POSTs to the course
 * sessions endpoint (tagging the session with course_id) and refreshes progress.
 * Each item title links to the scenario detail (level 2).
 */
import { useState } from 'react';
import Link from 'next/link';

interface Item { scenarioId: string; slug: string; name: string; completed: boolean; sessions: number; }
interface Props { slug: string; initialItems: Item[]; coachSlug: string | null; coachName: string | null; }

export default function CoursePlayer({ slug, initialItems, coachSlug, coachName }: Props) {
  const [items, setItems] = useState<Item[]>(initialItems);
  const [running, setRunning] = useState<string | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const completed = items.filter((i) => i.completed).length;
  const total = items.length;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  async function refreshProgress() {
    const res = await fetch(`/api/courses/${slug}/progress`);
    const data = await res.json();
    if (res.ok) setItems(data.progress.items);
  }

  async function startItem(scenarioSlug: string): Promise<boolean> {
    setRunning(scenarioSlug); setError(null);
    try {
      const res = await fetch(`/api/courses/${slug}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioSlug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      await refreshProgress();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setRunning(null);
    }
  }

  async function playAll() {
    setPlayingAll(true); setError(null);
    for (const item of items) {
      const ok = await startItem(item.slug);
      if (!ok) break;
    }
    setPlayingAll(false);
  }

  const busy = playingAll || running !== null;

  return (
    <div className="course-player">
      <div className="progress">
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
        <span className="progress-label">{completed}/{total} complete</span>
      </div>

      <div className="course-actions">
        <button className="btn join" onClick={playAll} disabled={busy || total === 0}>
          {playingAll ? 'Playing all…' : 'Play All'}
        </button>
        {coachSlug && (
          <Link className="btn" href={`/coaches/${coachSlug}`}>Coached by {coachName}</Link>
        )}
      </div>
      {error && <p className="notice" role="alert">{error}</p>}

      <ol className="course-list">
        {items.map((item, i) => (
          <li key={item.scenarioId} className={`course-item ${item.completed ? 'done' : ''}`}>
            <span className="seq">{i + 1}</span>
            <span className="status" aria-hidden>{item.completed ? '✓' : '○'}</span>
            <Link href={`/scenarios/${item.slug}`} className="item-name">{item.name}</Link>
            {item.sessions > 0 && <span className="badge">{item.sessions} run{item.sessions > 1 ? 's' : ''}</span>}
            <button className="btn small" onClick={() => startItem(item.slug)} disabled={busy}>
              {running === item.slug ? 'Running…' : 'Start'}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
