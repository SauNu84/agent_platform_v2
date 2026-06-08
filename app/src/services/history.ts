/**
 * Session History — per-user activity read-model (projection over `session` +
 * `analysis`, ERD `session_history` view). Powers the History tab's filterable
 * table and its CSV export. No new conversation engine — pure projection.
 */
import type { SessionHistoryRow, Store } from '@/db/store';
import { toCsv } from './csv';

export interface HistoryFilter {
  scenarioSlug?: string;
  status?: 'active' | 'completed' | 'failed';
  /** ISO date — only sessions started on/after this day */
  since?: string;
}

export async function listSessionHistory(
  store: Store,
  userId: string,
  filter: HistoryFilter = {},
): Promise<SessionHistoryRow[]> {
  const rows = await store.listSessionHistory(userId);
  return rows.filter((r) => {
    if (filter.scenarioSlug && r.scenarioSlug !== filter.scenarioSlug) return false;
    if (filter.status && r.status !== filter.status) return false;
    if (filter.since && r.startedAt < filter.since) return false;
    return true;
  });
}

const fmtDuration = (ms: number): string => {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

export function historyToCsv(rows: SessionHistoryRow[]): string {
  return toCsv(
    ['session_id', 'scenario', 'scenario_slug', 'started_at', 'duration', 'status', 'analyzed', 'final_score'],
    rows.map((r) => [
      r.sessionId,
      r.scenarioName,
      r.scenarioSlug,
      r.startedAt,
      r.durationMs > 0 ? fmtDuration(r.durationMs) : '',
      r.status,
      r.analyzed,
      r.finalScore ?? '',
    ]),
  );
}

export { fmtDuration };
