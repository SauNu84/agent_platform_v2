/**
 * Subscription plan catalog (SAU-250; re-priced by SAU-554).
 *
 * Static, original copy — NOT sourced from any competitor. `includedMinutes` becomes
 * the user's paid voice-minute allowance on subscribe; it stacks on top of the
 * default free allowance (subscription.ts / meter.ts), so a paid seat's real
 * monthly cap is `30 free + includedMinutes`.
 *
 * Pricing source: the A* price sheet ratified on SAU-534 (CEO ratification +
 * CPO paid-engine ruling = gpt-realtime-2.1-mini), solved on the COGS measured
 * in the SAU-519 same-day bench. Allowances are solved so every paid plan holds
 * the SAU-198 70% gross-margin floor at the ANNUAL rate — the binding case, since
 * annual is ~17% cheaper and reaches checkout via `amountForCycle()`. That floor
 * is enforced by tests/plans-margin.test.ts: re-pricing or changing an allowance
 * without re-solving it fails the build, not just this comment.
 *
 * Annual pricing is ~17% off the monthly run-rate (the "save 17%" toggle), expressed
 * as a per-month-equivalent so both cycles render in the same column.
 */
export type PlanId = 'free' | 'standard' | 'premium';
export type BillingCycle = 'monthly' | 'annual';

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in cents (the headline rate). 0 = free. */
  priceMonthlyCents: number;
  /** Per-month-equivalent price in cents when billed annually (~17% off). */
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
 * conversation-minute: $0.035 vendor (SAU-519) × 1.15 platform overhead (SAU-198
 * convention). Used by the margin guard test; update it when the engine or the
 * measured cost changes, and the floor is re-checked against every plan.
 */
export const VOICE_COGS_CENTS_PER_MINUTE = 3.5 * 1.15;

/** SAU-198 gross-margin floor every paid plan (and the top-up) must hold. */
export const GROSS_MARGIN_FLOOR = 0.7;

/**
 * Top-up rate for extra voice minutes, in cents per minute (SAU-534: $0.25/min,
 * ~83.9% GM on measured mini). The single source for the rate — re-price here.
 */
export const TOP_UP_CENTS_PER_MINUTE = 25;

/** ~17% annual discount, rounded to the nearest cent. */
const annual = (monthlyCents: number): number => Math.round(monthlyCents * 0.83);

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Start practicing with a generous monthly allowance.',
    priceMonthlyCents: 0,
    priceAnnualMonthlyCents: 0,
    includedMinutes: 30,
    features: ['30 practice minutes / month', 'Public & featured scenarios', 'Community support'],
    paid: false,
    topUpCentsPerMinute: null,
  },
  {
    id: 'standard',
    name: 'Standard',
    tagline: 'For regular practitioners who want more reps.',
    priceMonthlyCents: 1900,
    priceAnnualMonthlyCents: annual(1900),
    includedMinutes: 87,
    features: [
      '87 practice minutes / month',
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
    includedMinutes: 211,
    features: [
      '211 practice minutes / month',
      'Top up extra minutes anytime',
      'Advanced analytics & history export',
      'Coaches with persistent memory',
      'Priority support',
    ],
    paid: true,
    topUpCentsPerMinute: TOP_UP_CENTS_PER_MINUTE,
  },
];

export function getPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** The charged amount for a plan + cycle, in cents. Annual = 12× the monthly-equiv. */
export function amountForCycle(plan: Plan, cycle: BillingCycle): number {
  return cycle === 'annual' ? plan.priceAnnualMonthlyCents * 12 : plan.priceMonthlyCents;
}

/** Charge in cents for `minutes` of top-up on a plan; null if the plan has no top-up. */
export function topUpCents(plan: Plan, minutes: number): number | null {
  if (plan.topUpCentsPerMinute == null) return null;
  return Math.ceil(Math.max(0, minutes)) * plan.topUpCentsPerMinute;
}

/** Display helper — cents → "$19" / "$0" (whole dollars; placeholder pricing). */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
}
