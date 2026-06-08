/**
 * Creator Analytics — aggregate read-model over the creator's scenarios and the
 * sessions/usage run against them. Powers the KPI cards, the per-scenario table,
 * and the CSV export. Projection only (no conversation engine).
 */
import type { CreatorAnalyticsRow, Store } from '@/db/store';
import { toCsv } from './csv';

export interface CreatorAnalytics {
  rows: CreatorAnalyticsRow[];
  kpis: {
    totalScenarios: number;
    totalSessions: number;
    avgSessionsPerScenario: number;
    avgDurationMs: number;
    totalVoiceMinutes: number;
  };
}

export async function getCreatorAnalytics(store: Store): Promise<CreatorAnalytics> {
  const rows = await store.getCreatorAnalytics();
  const totalScenarios = rows.length;
  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
  const totalDurationMs = rows.reduce((s, r) => s + r.avgDurationMs * r.sessions, 0);
  const totalVoiceMinutes = rows.reduce((s, r) => s + r.totalVoiceMinutes, 0);
  return {
    rows,
    kpis: {
      totalScenarios,
      totalSessions,
      avgSessionsPerScenario: totalScenarios ? Number((totalSessions / totalScenarios).toFixed(2)) : 0,
      avgDurationMs: totalSessions ? Math.round(totalDurationMs / totalSessions) : 0,
      totalVoiceMinutes: Number(totalVoiceMinutes.toFixed(4)),
    },
  };
}

export function analyticsToCsv(rows: CreatorAnalyticsRow[]): string {
  return toCsv(
    ['scenario', 'scenario_slug', 'sessions', 'avg_duration_ms', 'voice_minutes'],
    rows.map((r) => [r.name, r.slug, r.sessions, r.avgDurationMs, r.totalVoiceMinutes]),
  );
}
