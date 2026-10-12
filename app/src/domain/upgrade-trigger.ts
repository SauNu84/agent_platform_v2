/**
 * Upgrade triggers (SAU-557 item 5; SAU-552 §4 H0) — what sent a user to checkout.
 * Read by the CPO's H0 test: ≥30% of upgrade starts from `feature_lock:*` means
 * minutes aren't the whole product; >70% from `cap_reached` means they are.
 *
 * Pure + client-safe. The value rides `/billing?trigger=…` → checkout → the
 * PII-free `platform.upgrade.started{trigger}` event. The prop key is `trigger`,
 * never `reason` (the track() PII guard rejects `reason`).
 */
export const PAYWALL_FEATURES = ['csv_export', 'coach_memory'] as const;
export type PaywallFeature = (typeof PAYWALL_FEATURES)[number];

export type UpgradeTrigger = 'cap_reached' | 'billing_page' | `feature_lock:${PaywallFeature}`;

/** Normalise a raw `?trigger=` value. Anything unrecognised ⇒ `billing_page`. */
export function normalizeUpgradeTrigger(raw: string | null | undefined): UpgradeTrigger {
  if (raw === 'cap_reached') return 'cap_reached';
  const feature = raw?.startsWith('feature_lock:') ? raw.slice('feature_lock:'.length) : raw;
  if ((PAYWALL_FEATURES as readonly string[]).includes(feature ?? '')) return `feature_lock:${feature as PaywallFeature}`;
  return 'billing_page';
}
