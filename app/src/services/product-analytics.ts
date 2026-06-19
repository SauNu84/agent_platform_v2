/**
 * Product analytics service (SAU-350, WS5) — the CMO's read-models over the
 * PII/PHI-free `product_event` stream (taxonomy in domain/analytics-events.ts;
 * DB contract in migration 0024).
 *
 * Two halves:
 *   1. `track()` — the ONLY sanctioned write path. It validates the payload is
 *      PII-free (assertPiiFree, fail-closed) before persisting. Wire emitters at
 *      product seams through this, never store.recordProductEvent directly.
 *   2. read-models — `getFunnelReport`, `getActivationReport`, `getRetentionReport`
 *      — projections the CMO acts on for UX / journey / CIP. Pure aggregation over
 *      the event rows; no engine, no PII.
 */
import type { ProductEventInput, ProductEventRecord, Store } from '@/db/store';
import {
  JOURNEYS, archetypeOf, assertPiiFree, type Archetype, type Journey,
} from '@/domain/analytics-events';
import { toCsv } from './csv';

/** Emit one product event. Fails closed if the payload carries PII/PHI. */
export async function track(store: Store, ev: ProductEventInput): Promise<void> {
  assertPiiFree(ev.props); // throws PiiViolationError → caller does NOT persist
  await store.recordProductEvent({ ...ev, archetype: ev.archetype ?? archetypeOf(ev.event) });
}

/**
 * Best-effort emit: never let an analytics write break a product flow. Used by
 * the wired seams (session/scenario lifecycle) so a tracking failure — including
 * a PII-guard rejection — is logged and swallowed, not propagated to the user.
 */
export async function trackSafe(store: Store, ev: ProductEventInput): Promise<void> {
  try {
    await track(store, ev);
  } catch (err) {
    console.warn(`[product-analytics] dropped event "${ev.event}":`, (err as Error).message);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** The cohort key for a row, per the journey's unit (tenant vs end-user). */
function cohortKey(row: ProductEventRecord, cohort: Journey['cohort']): string | null {
  return cohort === 'tenant' ? row.tenantId : row.actorId;
}

/** ISO-week bucket key ('YYYY-Www') for a timestamp — the retention grain. */
export function isoWeek(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const yearStart = new Date(Date.UTC(monday.getUTCFullYear(), 0, 1));
  const week = Math.floor((monday.getTime() - yearStart.getTime()) / 604_800_000) + 1;
  return `${monday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── Funnel ─────────────────────────────────────────────────────────────────

export interface FunnelStepResult {
  event: string;
  label: string;
  /** distinct cohort entities (tenants or actors) that reached this step. */
  reached: number;
  /** conversion from the PREVIOUS step (1 for the first step). */
  stepConversion: number;
  /** conversion from the FIRST step. */
  overallConversion: number;
  activation: boolean;
  value: boolean;
}

export interface FunnelReport {
  archetype: Archetype;
  title: string;
  cohort: Journey['cohort'];
  window: { since: string | null; until: string | null };
  steps: FunnelStepResult[];
}

export interface ReportWindow {
  since?: string;
  until?: string;
  tenantId?: string;
}

/**
 * Funnel for one archetype journey: distinct cohort entities reaching each
 * ordered step, with step-over-step and overall conversion. A cohort entity
 * "reached" a step if it logged that event anywhere in the window.
 */
export async function getFunnelReport(
  store: Store,
  archetype: keyof typeof JOURNEYS,
  window: ReportWindow = {},
): Promise<FunnelReport> {
  const journey = JOURNEYS[archetype];
  const rows = await store.queryProductEvents({
    archetype: journey.archetype,
    events: journey.steps.map((s) => s.event),
    since: window.since,
    until: window.until,
    tenantId: window.tenantId,
  });

  // event name → set of distinct cohort keys that fired it
  const byEvent = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = cohortKey(row, journey.cohort);
    if (!key) continue;
    if (!byEvent.has(row.event)) byEvent.set(row.event, new Set());
    byEvent.get(row.event)!.add(key);
  }

  const counts = journey.steps.map((s) => byEvent.get(s.event)?.size ?? 0);
  const first = counts[0] || 0;
  const steps: FunnelStepResult[] = journey.steps.map((s, i) => ({
    event: s.event,
    label: s.label,
    reached: counts[i],
    stepConversion: i === 0 ? 1 : ratio(counts[i], counts[i - 1]),
    overallConversion: ratio(counts[i], first),
    activation: !!s.activation,
    value: !!s.value,
  }));

  return {
    archetype: journey.archetype,
    title: journey.title,
    cohort: journey.cohort,
    window: { since: window.since ?? null, until: window.until ?? null },
    steps,
  };
}

// ── Activation ───────────────────────────────────────────────────────────────

export interface ActivationReport {
  archetype: Archetype;
  title: string;
  cohort: Journey['cohort'];
  /** entities that entered the journey (did the first step). */
  entered: number;
  /** entities that reached the activation step. */
  activated: number;
  activationRate: number;
  /** entities that reached the value step. */
  realizedValue: number;
  valueRate: number;
}

/** Activation + value-realization rates for an archetype journey. */
export async function getActivationReport(
  store: Store,
  archetype: keyof typeof JOURNEYS,
  window: ReportWindow = {},
): Promise<ActivationReport> {
  const funnel = await getFunnelReport(store, archetype, window);
  const journey = JOURNEYS[archetype];
  const entered = funnel.steps[0]?.reached ?? 0;
  const act = funnel.steps.find((s) => s.activation);
  const val = funnel.steps.find((s) => s.value);
  const activated = act?.reached ?? 0;
  const realizedValue = val?.reached ?? 0;
  return {
    archetype: journey.archetype,
    title: journey.title,
    cohort: journey.cohort,
    entered,
    activated,
    activationRate: ratio(activated, entered),
    realizedValue,
    valueRate: ratio(realizedValue, entered),
  };
}

// ── Retention ────────────────────────────────────────────────────────────────

export interface RetentionWeek {
  week: string;
  active: number;
  /** of `active`, how many were also active the FOLLOWING week (W+1). */
  retainedNextWeek: number;
  retentionRate: number;
}

export interface RetentionReport {
  archetype: Archetype | 'all';
  cohort: Journey['cohort'];
  weeks: RetentionWeek[];
}

/**
 * Week-over-week (W→W+1) retention of cohort entities active for an archetype.
 * "Active" = logged any event for that archetype in the week. The final week has
 * no successor, so its retention is reported against an empty next week (0).
 */
export async function getRetentionReport(
  store: Store,
  archetype: keyof typeof JOURNEYS,
  window: ReportWindow = {},
): Promise<RetentionReport> {
  const journey = JOURNEYS[archetype];
  const rows = await store.queryProductEvents({
    archetype: journey.archetype,
    since: window.since,
    until: window.until,
    tenantId: window.tenantId,
  });

  // week → set of distinct active cohort keys
  const active = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = cohortKey(row, journey.cohort);
    if (!key) continue;
    const wk = isoWeek(row.ts);
    if (!active.has(wk)) active.set(wk, new Set());
    active.get(wk)!.add(key);
  }

  const weeks = [...active.keys()].sort();
  const result: RetentionWeek[] = weeks.map((wk, i) => {
    const thisWeek = active.get(wk)!;
    const next = i + 1 < weeks.length ? active.get(weeks[i + 1])! : new Set<string>();
    let retained = 0;
    for (const k of thisWeek) if (next.has(k)) retained += 1;
    return {
      week: wk,
      active: thisWeek.size,
      retainedNextWeek: retained,
      retentionRate: ratio(retained, thisWeek.size),
    };
  });

  return { archetype: journey.archetype, cohort: journey.cohort, weeks: result };
}

// ── CSV export (CMO download) ─────────────────────────────────────────────────

export function funnelToCsv(report: FunnelReport): string {
  return toCsv(
    ['archetype', 'step', 'label', 'reached', 'step_conversion', 'overall_conversion'],
    report.steps.map((s) => [
      report.archetype, s.event, s.label, s.reached,
      pct(s.stepConversion), pct(s.overallConversion),
    ]),
  );
}

// ── numeric helpers ───────────────────────────────────────────────────────────

function ratio(n: number, d: number): number {
  return d > 0 ? Number((n / d).toFixed(4)) : 0;
}
function pct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}
