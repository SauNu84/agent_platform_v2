/**
 * Paywall seams for plan-gated features (SAU-557). The gate itself is
 * `planFeatures` (voice/plan-features.ts); this is what the user sees when it
 * says no, plus the PII-free `platform.paywall.viewed` event.
 */
import { NextResponse } from 'next/server';
import type { Store } from '@/db/store';
import { PRODUCT_EVENTS } from '@/domain/analytics-events';
import { trackSafe } from './product-analytics';
import { planFeatures, resolvePlanTierForUser } from '@/voice/plan-features';

import { PAYWALL_FEATURES, type PaywallFeature } from '@/domain/upgrade-trigger';

export { PAYWALL_FEATURES, type PaywallFeature };

/** Where an upgrade CTA for `feature` sends the user — the trigger rides to checkout. */
export function upgradeHref(feature: PaywallFeature): string {
  return `/billing?trigger=${feature}`;
}

/** 402 for a CSV export the plan doesn't include. */
export function csvExportLocked(): NextResponse {
  return NextResponse.json(
    { error: 'CSV export is included in Premium.', feature: 'csv_export', upgradeUrl: upgradeHref('csv_export') },
    { status: 402 },
  );
}

/**
 * For a server page that renders a CSV export button: is it unlocked for this user?
 * When it isn't, records `paywall.viewed{feature: csv_export}` (the lock is shown).
 * Returns the upgrade URL to render instead of the export link, or null if unlocked.
 */
export async function csvExportLockFor(store: Store, userId: string | null): Promise<string | null> {
  if (userId && planFeatures(await resolvePlanTierForUser(store, userId)).csvExport) return null;
  if (userId) await emitPaywallViewed(store, userId, 'csv_export');
  return upgradeHref('csv_export');
}

/** `platform.paywall.viewed` — a locked feature was rendered to this user. */
export async function emitPaywallViewed(store: Store, userId: string, feature: PaywallFeature): Promise<void> {
  await trackSafe(store, {
    event: PRODUCT_EVENTS.PAYWALL_VIEWED,
    surface: 'web',
    actorId: userId,
    props: { feature },
  });
}

/** `platform.analysis.viewed{scorer}` — a session report was shown (SAU-552 H2). */
export async function emitAnalysisViewed(store: Store, userId: string, scorer: string): Promise<void> {
  await trackSafe(store, {
    event: PRODUCT_EVENTS.ANALYSIS_VIEWED,
    surface: 'web',
    actorId: userId,
    // 'heuristic' | 'llm' — the model suffix isn't needed for H2 and stays out of props.
    props: { scorer: scorer.split(':')[0] },
  });
}

/** `platform.scenario.generated{kind, valid}` — AI authoring produced a draft (SAU-552 H3). */
export async function emitScenarioGenerated(store: Store, userId: string, kind: 'scenario' | 'course', valid: boolean): Promise<void> {
  await trackSafe(store, {
    event: PRODUCT_EVENTS.SCENARIO_GENERATED,
    surface: 'web',
    actorId: userId,
    props: { kind, valid },
  });
}
