/**
 * Subscription plan catalog (SAU-250).
 *
 * Static, original copy — NOT sourced from any competitor. Prices are placeholder
 * MVP values the board can revise ("we can add the cost later"); they are grounded
 * in our own unit economics (Gate-1, SAU-220/222: ~$25–29/seat at a 25-min cap to
 * hold target gross margin). `includedMinutes` becomes the user's paid voice-minute
 * allowance on subscribe; it stacks on top of the default free allowance.
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
}

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
  },
  {
    id: 'standard',
    name: 'Standard',
    tagline: 'For regular practitioners who want more reps.',
    priceMonthlyCents: 1900,
    priceAnnualMonthlyCents: annual(1900),
    includedMinutes: 120,
    features: [
      '120 practice minutes / month',
      'Every scenario category',
      'Session analytics & scoring',
      'Priority support',
    ],
    paid: true,
  },
  {
    id: 'premium',
    name: 'Premium',
    tagline: 'Unlimited-feeling practice for power users and teams.',
    priceMonthlyCents: 3900,
    priceAnnualMonthlyCents: annual(3900),
    includedMinutes: 300,
    features: [
      '300 practice minutes / month',
      'Top up extra minutes anytime',
      'Advanced analytics & history export',
      'Coaches with persistent memory',
      'Priority support',
    ],
    paid: true,
  },
];

export function getPlan(id: string): Plan | undefined {
  return PLANS.find((p) => p.id === id);
}

/** The charged amount for a plan + cycle, in cents. Annual = 12× the monthly-equiv. */
export function amountForCycle(plan: Plan, cycle: BillingCycle): number {
  return cycle === 'annual' ? plan.priceAnnualMonthlyCents * 12 : plan.priceMonthlyCents;
}

/** Display helper — cents → "$19" / "$0" (whole dollars; placeholder pricing). */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
}
