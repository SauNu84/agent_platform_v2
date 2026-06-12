/**
 * POST /api/billing/checkout/[id]/confirm — confirm a paid checkout (SAU-250).
 *
 * Called by the payment provider's success return (or, under the mock provider,
 * by the simulated "Pay" button). Marks the checkout completed and upgrades the
 * user's entitlement. Idempotent. Only the owner of the checkout may confirm it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getActor } from '@/services/current-user';
import { confirmCheckout, InvalidPlanError } from '@/services/billing/subscription';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  const store = getStore();
  const existing = await store.getCheckout(params.id);
  if (!existing) return NextResponse.json({ error: 'checkout not found' }, { status: 404 });
  if (existing.userId !== actor.userId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const result = await confirmCheckout(store, params.id);
    if (!result) return NextResponse.json({ error: 'checkout not completable' }, { status: 409 });
    return NextResponse.json(
      { planTier: result.entitlement.planTier, plan: result.entitlement.plan },
      { status: 200 },
    );
  } catch (e) {
    if (e instanceof InvalidPlanError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
