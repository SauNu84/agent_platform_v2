/**
 * /api/history — per-user Session History (read-model over session + analysis).
 * Supports filters (?scenario=&status=&since=) and CSV export (?format=csv).
 * CSV export is a plan feature (SAU-557): gated only through `planFeatures`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { listSessionHistory, historyToCsv, type HistoryFilter } from '@/services/history';
import { getActor } from '@/services/current-user';
import { planFeatures, resolvePlanTierForUser } from '@/voice/plan-features';
import { csvExportLocked } from '@/services/paywall';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const store = getStore();
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
  const userId = actor.userId;
  const sp = req.nextUrl.searchParams;
  const filter: HistoryFilter = {};
  if (sp.get('scenario')) filter.scenarioSlug = sp.get('scenario')!;
  const status = sp.get('status');
  if (status === 'active' || status === 'completed' || status === 'failed') filter.status = status;
  if (sp.get('since')) filter.since = sp.get('since')!;

  if (sp.get('format') === 'csv' && !planFeatures(await resolvePlanTierForUser(store, userId)).csvExport) {
    return csvExportLocked();
  }

  const rows = await listSessionHistory(store, userId, filter);

  if (sp.get('format') === 'csv') {
    return new NextResponse(historyToCsv(rows), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="session-history.csv"',
      },
    });
  }
  return NextResponse.json({ history: rows });
}
