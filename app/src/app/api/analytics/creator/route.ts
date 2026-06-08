/**
 * /api/analytics/creator — Creator Analytics aggregate (KPIs + per-scenario rows).
 * CSV export of the per-scenario table via ?format=csv.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getCreatorAnalytics, analyticsToCsv } from '@/services/analytics';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const store = getStore();
  const analytics = await getCreatorAnalytics(store);

  if (req.nextUrl.searchParams.get('format') === 'csv') {
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
