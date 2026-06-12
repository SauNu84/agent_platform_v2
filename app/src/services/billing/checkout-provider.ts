/**
 * Checkout provider seam (SAU-250).
 *
 * The plan-selection modal hands the user off to an external payment page. WHICH
 * page is a swappable seam — same pattern as the Author / Scorer / ChatResponder
 * seams elsewhere in the app:
 *
 *   • MockCheckoutProvider (default)  — returns an INTERNAL simulated hosted-checkout
 *     URL (`/billing/checkout/{id}`). Lets the whole flow be exercised end-to-end
 *     with no payment account or secret keys — the POC default.
 *   • StripeCheckoutProvider          — creates a real Stripe Checkout Session and
 *     returns its hosted URL. Key-gated on STRIPE_SECRET_KEY.
 *   • DodoCheckoutProvider            — same shape against the DodoPayments API.
 *     Key-gated on DODO_API_KEY.
 *
 * Selection: BILLING_PROVIDER = mock | stripe | dodo (default mock). A real provider
 * is only used when its key is present; otherwise we fail SOFT to the mock so the
 * Billing UI always works (consistent with the live-LLM seams that mock without a key).
 */
import type { BillingCycle, Plan } from './plans';

export interface CheckoutSessionInput {
  checkoutId: string;
  plan: Plan;
  cycle: BillingCycle;
  amountCents: number;
  userId: string;
  /** Where the provider returns the user after a successful payment. */
  successUrl: string;
  /** Where the provider returns the user if they cancel. */
  cancelUrl: string;
}

export interface CheckoutSession {
  /** The URL to redirect the user to (the hosted payment page). */
  url: string;
  /** Which provider minted this session. */
  provider: string;
}

export interface CheckoutProvider {
  readonly name: string;
  createSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
}

/** Default, key-free provider: routes to our own simulated hosted-checkout page. */
export class MockCheckoutProvider implements CheckoutProvider {
  readonly name = 'mock';
  async createSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    return { url: `/billing/checkout/${input.checkoutId}`, provider: this.name };
  }
}

/** Live Stripe Checkout Session (key-gated). Raw fetch — no SDK dependency. */
export class StripeCheckoutProvider implements CheckoutProvider {
  readonly name = 'stripe';
  constructor(private readonly secretKey: string) {}

  async createSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    // Stripe expects application/x-www-form-urlencoded with nested keys.
    const body = new URLSearchParams({
      mode: 'subscription',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.checkoutId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(input.amountCents),
      'line_items[0][price_data][recurring][interval]': input.cycle === 'annual' ? 'year' : 'month',
      'line_items[0][price_data][product_data][name]': `${input.plan.name} plan`,
    });
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) throw new Error(`stripe checkout failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { url?: string };
    if (!json.url) throw new Error('stripe checkout returned no url');
    return { url: json.url, provider: this.name };
  }
}

/** Live DodoPayments hosted checkout (key-gated). Raw fetch. */
export class DodoCheckoutProvider implements CheckoutProvider {
  readonly name = 'dodo';
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://api.dodopayments.com') {}

  async createSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const res = await fetch(`${this.baseUrl}/checkouts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reference_id: input.checkoutId,
        amount_cents: input.amountCents,
        currency: 'USD',
        billing_cycle: input.cycle,
        product_name: `${input.plan.name} plan`,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      }),
    });
    if (!res.ok) throw new Error(`dodo checkout failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { checkout_url?: string; url?: string };
    const url = json.checkout_url ?? json.url;
    if (!url) throw new Error('dodo checkout returned no url');
    return { url, provider: this.name };
  }
}

/**
 * Resolve the active provider from env. Falls back to the mock provider whenever
 * the requested live provider has no key configured (fail-soft).
 */
export function getCheckoutProvider(): CheckoutProvider {
  const choice = (process.env.BILLING_PROVIDER ?? 'mock').toLowerCase();
  if (choice === 'stripe' && process.env.STRIPE_SECRET_KEY) {
    return new StripeCheckoutProvider(process.env.STRIPE_SECRET_KEY);
  }
  if (choice === 'dodo' && process.env.DODO_API_KEY) {
    return new DodoCheckoutProvider(process.env.DODO_API_KEY);
  }
  return new MockCheckoutProvider();
}
