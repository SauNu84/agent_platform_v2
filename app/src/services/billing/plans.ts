/**
 * Subscription plan catalog (SAU-250; re-priced by SAU-554).
 *
 * Static, original copy — NOT sourced from any competitor. `includedMinutes` becomes
 * the user's paid voice-minute allowance on subscribe; it stacks on top of the
 * default free allowance (subscription.ts / meter.ts), so a paid seat's real
 * monthly cap is `30 free + includedMinutes`.
 *
 * Pricing source: the A* price sheet ratified on SAU-534 (CEO ratification +
 * CPO paid-engine ruling = gpt-realtime-2.1-mini), re-cut by the CRO on SAU-534 to
 * 73/182 at a 10% annual discount once payment processing was counted as COGS.
 * Allowances are solved so every paid plan holds the SAU-198 70% gross-margin floor
 * at full cap, on either cycle, under every candidate processor (SAU-556) — the
 * binding case is Standard annual on Dodo. That floor is enforced by
 * tests/plans-margin.test.ts: re-pricing or changing an allowance without
 * re-solving it fails the build, not just this comment.
 *
 * Annual pricing is ANNUAL_DISCOUNT off the monthly run-rate (the "save N%" toggle
 * reads the same constant), expressed as a per-month-equivalent so both cycles
 * render in the same column.
 */
export type PlanId = 'free' | 'standard' | 'premium';
export type BillingCycle = 'monthly' | 'annual';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in cents (the headline rate). 0 = free. */
  priceMonthlyCents: number;
  /** Per-month-equivalent price in cents when billed annually (ANNUAL_DISCOUNT off). */
  priceAnnualMonthlyCents: number;
  /** Voice-minute allowance this plan grants. */
  includedMinutes: number;
  /** Marketing bullet list (original copy). */
  features: string[];
  /** Whether selecting this plan triggers a paid checkout. */
  paid: boolean;
  /** Price per extra voice minute beyond the allowance, in cents; null = no top-up. */
  topUpCentsPerMinute: number | null;
}

/**
 * Measured all-in voice COGS on the paid engine (gpt-realtime-2.1-mini), cents per
 * conversation-minute: $0.035 vendor (measured 2026-09-21, SAU-519) × 1.15 platform overhead (SAU-198
 * convention). Used by the margin guard test; update it when the engine or the
 * measured cost changes, and the floor is re-checked against every plan.
 *
 * all-in = vendor × 1.15 (SAU-198 / COST-ENVELOPE §2: transport, egress, observability).
 * NOTE: this loading EXCLUDES payment processing (2.9–5.5% of revenue + a fixed
 * per-transaction fee). Solving a retail price against this constant alone
 * understates COGS — see SAU-534 / SAU-556 (processor not yet chosen).
 */
export const VOICE_COGS_CENTS_PER_MINUTE = 3.5 * 1.15;

/** SAU-198 gross-margin floor every paid plan (and the top-up) must hold. */
export const GROSS_MARGIN_FLOOR = 0.7;

/**
 * Top-up rate for extra voice minutes, in cents per minute (SAU-534: $0.25/min,
 * ~83.9% GM on measured mini). The single source for the rate — re-price here.
 */
export const TOP_UP_CENTS_PER_MINUTE = 25;

/**
 * Top-ups are sold in fixed blocks, not open per-minute purchases: the processor's
 * fixed per-transaction fee is regressive in bundle size, so a small top-up breaches
 * the floor on its own (10 min ≈ 59% GM on Paddle). 30 min ($7.50) holds ≥70% under
 * every processor scenario on SAU-556 (CFO, SAU-554 comment).
 */
export const TOP_UP_BLOCK_MINUTES = 30;

/**
 * The allowance line is derived from `includedMinutes`, never hand-written: the
 * displayed minutes are a published price, so a re-price must be one edit.
 */
const withMinutesFeature = (plan: Plan): Plan => ({
  ...plan,
  features: [`${plan.includedMinutes} practice minutes / month`, ...plan.features],
});

/** Annual-billing discount off the monthly rate (SAU-534: 10%). The toggle copy reads this. */
export const ANNUAL_DISCOUNT = 0.1;

/** Per-month-equivalent annual price, rounded to the nearest cent. */
const annual = (monthlyCents: number): number => Math.round(monthlyCents * (1 - ANNUAL_DISCOUNT));

/** Plan specs; `features` here omits the allowance line, which is derived. */
const PLAN_SPECS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Start practicing with a generous monthly allowance.',
    priceMonthlyCents: 0,
    priceAnnualMonthlyCents: 0,
    includedMinutes: 30,
    features: ['Public & featured scenarios', 'Community support'],
    paid: false,
    topUpCentsPerMinute: null,
  },
  {
    id: 'standard',
    name: 'Standard',
    tagline: 'For regular practitioners who want more reps.',
    priceMonthlyCents: 1900,
    priceAnnualMonthlyCents: annual(1900),
    includedMinutes: 73,
    features: [
      'Every scenario category',
      'Session analytics & scoring',
      'Priority support',
    ],
    paid: true,
    topUpCentsPerMinute: null,
  },
  {
    id: 'premium',
    name: 'Premium',
    tagline: 'Unlimited-feeling practice for power users and teams.',
    priceMonthlyCents: 3900,
    priceAnnualMonthlyCents: annual(3900),
    includedMinutes: 182,
    features: [
      `Top up extra minutes anytime (${TOP_UP_BLOCK_MINUTES}-min blocks)`,
      'Advanced analytics & history export',
      'Coaches with persistent memory',
      'Priority support',
    ],
    paid: true,
    topUpCentsPerMinute: TOP_UP_CENTS_PER_MINUTE,
  },
];

export const PLANS: Plan[] = PLAN_SPECS.map(withMinutesFeature);

export function getPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** The charged amount for a plan + cycle, in cents. Annual = 12× the monthly-equiv. */
export function amountForCycle(plan: Plan, cycle: BillingCycle): number {
  return cycle === 'annual' ? plan.priceAnnualMonthlyCents * 12 : plan.priceMonthlyCents;
}

/** Whole top-up blocks needed to cover `minutes` of extra usage. */
export function topUpBlocks(minutes: number): number {
  return Math.ceil(Math.max(0, minutes) / TOP_UP_BLOCK_MINUTES);
}

/**
 * Charge in cents to cover `minutes` of top-up on a plan, rounded up to whole
 * TOP_UP_BLOCK_MINUTES blocks; null if the plan has no top-up.
 */
export function topUpCents(plan: Plan, minutes: number): number | null {
  if (plan.topUpCentsPerMinute == null) return null;
  return topUpBlocks(minutes) * TOP_UP_BLOCK_MINUTES * plan.topUpCentsPerMinute;
}

/** Display helper — cents → "$19" / "$0" (whole dollars; placeholder pricing). */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
}
