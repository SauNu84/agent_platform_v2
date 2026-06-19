/**
 * Client-side marketing event seam (SAU-349 landing page).
 *
 * The landing page must be instrumented so the WS5 analytics workstream
 * (SAU-350, owned by Data Eng) can attribute design-partner demand without
 * re-touching page markup. Rather than hard-wire a provider here — the WS5
 * choice (GA4 / GTM / Segment / internal CIP) is not yet made — we push every
 * event onto the GTM-standard `window.dataLayer` queue. That queue is the one
 * seam every mainstream analytics provider can consume, and it is created lazily
 * so events fired before a provider loads are not lost.
 *
 * This is intentionally dependency-free and fail-soft: a tracking call must
 * never break the marketing surface. When WS5 lands, it wires a real sink to
 * `dataLayer` (or replaces `track` internals) — no edits to the page itself.
 */

export type TrackEvent =
  | 'landing_view'
  | 'cta_design_partner_click'
  | 'cta_how_it_works_click'
  | 'archetype_view'
  | 'archetype_cta_click';

export type TrackProps = Record<string, string | number | boolean | undefined>;

type DataLayerEntry = { event: TrackEvent; ts: number } & TrackProps;

declare global {
  interface Window {
    dataLayer?: DataLayerEntry[];
  }
}

/**
 * Emit a marketing analytics event. No-ops safely on the server and never
 * throws. `ts` is stamped client-side at fire time (epoch ms).
 */
export function track(event: TrackEvent, props: TrackProps = {}): void {
  if (typeof window === 'undefined') return;
  try {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event, ts: Date.now(), ...props });
  } catch {
    /* analytics must never break the page */
  }
}
