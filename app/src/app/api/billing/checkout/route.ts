/**
 * POST /api/billing/checkout — start a subscription checkout (SAU-250).
 *
 * Body: { planId: 'standard' | 'premium', cycle?: 'monthly' | 'annual' }.
 * Persists a pending checkout and returns { url } — the hosted payment page to
 * redirect the user to (Stripe / DodoPayments in prod; an internal simulated
 * page under the default mock provider).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getActor } from '@/services/current-user';
import { startCheckout, InvalidPlanError } from '@/services/billing/subscription';
import { trackSafe } from '@/services/product-analytics';
import { PRODUCT_EVENTS } from '@/domain/analytics-events';
import { normalizeUpgradeTrigger } from '@/domain/upgrade-trigger';
import type { BillingCycle } from '@/services/billing/plans';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  let body: { planId?: string; cycle?: string; trigger?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const cycle: BillingCycle = body.cycle === 'annual' ? 'annual' : 'monthly';
  try {
    const result = await startCheckout(
      getStore(),
      actor.userId,
      String(body.planId ?? ''),
      cycle,
      req.nextUrl.origin,
    );
    // SAU-557: what sent this user to checkout (PII-free; `trigger`, never `reason`).
    await trackSafe(getStore(), {
      event: PRODUCT_EVENTS.UPGRADE_STARTED,
      surface: 'web',
      actorId: actor.userId,
      props: { trigger: normalizeUpgradeTrigger(body.trigger), plan_id: result.plan.id, cycle },
    });
    return NextResponse.json(
      { checkoutId: result.checkoutId, url: result.url, provider: result.provider },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof InvalidPlanError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
