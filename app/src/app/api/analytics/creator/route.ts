/**
 * /api/analytics/creator — Creator Analytics aggregate (KPIs + per-scenario rows).
 * CSV export of the per-scenario table via ?format=csv — a plan feature (SAU-557),
 * gated only through `planFeatures`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCreatorAnalytics, analyticsToCsv } from '@/services/analytics';
import { getActor } from '@/services/current-user';
import { planFeatures, resolvePlanTierForUser } from '@/voice/plan-features';
import { csvExportLocked } from '@/services/paywall';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const store = getStore();
  const csv = req.nextUrl.searchParams.get('format') === 'csv';
  if (csv) {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });
    if (!planFeatures(await resolvePlanTierForUser(store, actor.userId)).csvExport) return csvExportLocked();
  }
  const analytics = await getCreatorAnalytics(store);

  if (csv) {
    return new NextResponse(analyticsToCsv(analytics.rows), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="creator-analytics.csv"',
      },
    });
  }
  return NextResponse.json(analytics);
}
