/**
 * Product-analytics event taxonomy + per-archetype journeys (SAU-350, WS5).
 *
 * This is the single source of truth for *what we measure* about how the product
 * is used — the vocabulary the CMO's funnel / activation / retention read-models
 * (services/product-analytics.ts) project over. It is deliberately separate from
 * two neighbours:
 *   - `audit_log` (ADR-004) records PRIVACY events (memory/consent/DSAR);
 *   - `phi_access_log` (SAU-275) records PHI access for compliance.
 * Product events are NEITHER — they answer "is the UX working / is the journey
 * converting", and they carry NO PHI and NO PII by construction (see the guard
 * below + the matching DB contract in migration 0024).
 *
 * Grounded in the WS2 archetype PRDs (SAU-347): Clinic Secretary and the HRM
 * Interview Panel. (The Meeting Notetaker archetype was shelved — SAU-371/362
 * cancelled per the SAU-352 design-partner rollback — and its inert taxonomy
 * entries were stripped under SAU-380.) Each archetype's journey is an ORDERED
 * funnel whose steps are event names; the read-model converts a step list + a
 * window into a conversion/activation/retention picture.
 */

/** The product surfaces an event can originate from (PRD modalities). */
export const SURFACES = ['web', 'voice', 'sms', 'batch', 'slack', 'email'] as const;
export type Surface = (typeof SURFACES)[number];

/** The flagship archetypes (SAU-347) plus the cross-cutting platform bucket. */
export const ARCHETYPES = ['platform', 'clinic', 'hrm', 'collections'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/**
 * Canonical event names. Scheme: `<archetype>.<noun>.<verb>` so the archetype is
 * recoverable from the name (see `archetypeOf`). Add new names HERE — never emit
 * an ad-hoc string, so the taxonomy stays closed and the CMO's reports stay
 * comparable over time.
 */
export const PRODUCT_EVENTS = {
  // ── platform / creator (cross-archetype) ──────────────────────────────────
  PLATFORM_SIGNUP: 'platform.account.signed_up',
  AGENT_CREATED: 'platform.agent.created',
  TEMPLATE_INSTANTIATED: 'platform.template.instantiated',
  /** archetype-agnostic engagement event from the generic session run path. */
  SESSION_COMPLETED: 'platform.agent.session.completed',
  // ── paid-tier packaging (SAU-557) — must be live before the first real cohort ─
  /** a locked paid feature was shown to the user. props: { feature } */
  PAYWALL_VIEWED: 'platform.paywall.viewed',
  /** a checkout was started. props: { trigger, plan_id, cycle } (`trigger`, never `reason`) */
  UPGRADE_STARTED: 'platform.upgrade.started',
  /** coach memories were injected into a session. props: { count } */
  COACH_MEMORY_RECALLED: 'platform.coach_memory.recalled',
  /** a session analysis report was shown. props: { scorer } */
  ANALYSIS_VIEWED: 'platform.analysis.viewed',
  /** AI authoring produced a draft. props: { kind, valid } */
  SCENARIO_GENERATED: 'platform.scenario.generated',

  // ── Clinic Secretary (single-agent · web/voice/sms) ───────────────────────
  CLINIC_DEMO_VIEWED: 'clinic.demo.viewed',
  CLINIC_SETUP_STARTED: 'clinic.setup.started',
  CLINIC_CALENDAR_CONNECTED: 'clinic.calendar.connected',
  CLINIC_SESSION_STARTED: 'clinic.session.started',
  CLINIC_SESSION_COMPLETED: 'clinic.session.completed',
  CLINIC_BOOKING_COMPLETED: 'clinic.booking.completed',
  CLINIC_CONFIRMATION_SENT: 'clinic.confirmation.sent',
  CLINIC_ESCALATED: 'clinic.session.escalated',

  // ── HRM Interview Panel (super-agent · web text) ──────────────────────────
  HRM_TEMPLATE_INSTANTIATED: 'hrm.template.instantiated',
  HRM_PANEL_CONFIGURED: 'hrm.panel.configured',
  HRM_SESSION_STARTED: 'hrm.session.started',
  HRM_SPECIALIST_ACTIVATED: 'hrm.specialist.activated',
  HRM_SESSION_COMPLETED: 'hrm.session.completed',
  HRM_ASSESSMENT_GENERATED: 'hrm.assessment.generated',
  HRM_ASSESSMENT_RATED: 'hrm.assessment.rated',
} as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS];

/** Recover the archetype dimension from an event name's prefix. */
export function archetypeOf(event: string): Archetype {
  const prefix = event.split('.', 1)[0];
  return (ARCHETYPES as readonly string[]).includes(prefix) ? (prefix as Archetype) : 'platform';
}

/** One ordered step in an archetype's journey funnel. */
export interface JourneyStep {
  event: ProductEventName;
  label: string;
  /** the step that marks a user/tenant as ACTIVATED (reached first value). */
  activation?: boolean;
  /** the step that represents realized product VALUE (the job done). */
  value?: boolean;
}

export interface Journey {
  archetype: Archetype;
  title: string;
  /** the unit a funnel/retention cohort counts (per-tenant vs per-end-user). */
  cohort: 'tenant' | 'actor';
  steps: JourneyStep[];
}

/**
 * Per-archetype journeys, straight from the WS2 PRDs. The funnel read-model
 * walks `steps` in order; `activation`/`value` flags drive the activation and
 * value-conversion metrics. Keep these in sync with the PRDs as scope firms up.
 */
export const JOURNEYS: Record<Exclude<Archetype, 'platform' | 'collections'>, Journey> = {
  clinic: {
    archetype: 'clinic',
    title: 'Clinic Secretary',
    cohort: 'tenant',
    steps: [
      { event: PRODUCT_EVENTS.CLINIC_DEMO_VIEWED, label: 'Viewed demo' },
      { event: PRODUCT_EVENTS.CLINIC_SETUP_STARTED, label: 'Started setup' },
      { event: PRODUCT_EVENTS.CLINIC_CALENDAR_CONNECTED, label: 'Connected calendar', activation: true },
      { event: PRODUCT_EVENTS.CLINIC_SESSION_COMPLETED, label: 'Ran a session' },
      { event: PRODUCT_EVENTS.CLINIC_BOOKING_COMPLETED, label: 'Booked an appointment', value: true },
    ],
  },
  hrm: {
    archetype: 'hrm',
    title: 'HRM Interview Panel',
    cohort: 'actor',
    steps: [
      { event: PRODUCT_EVENTS.HRM_TEMPLATE_INSTANTIATED, label: 'Instantiated panel' },
      { event: PRODUCT_EVENTS.HRM_PANEL_CONFIGURED, label: 'Configured specialists', activation: true },
      { event: PRODUCT_EVENTS.HRM_SESSION_COMPLETED, label: 'Ran a panel session' },
      { event: PRODUCT_EVENTS.HRM_ASSESSMENT_GENERATED, label: 'Got assessment', value: true },
      { event: PRODUCT_EVENTS.HRM_ASSESSMENT_RATED, label: 'Rated assessment' },
    ],
  },
};

// ── Privacy guard ───────────────────────────────────────────────────────────
// Product events MUST NOT carry PHI or PII. Two layers enforce it: this runtime
// guard at the `track()` boundary, and the DB contract (migration 0024 stores
// only ids/enums/counts in jsonb `props`). Defence in depth — the same posture
// as audit_log ("counts/ids only — NO PII content").

/** Keys that smell like identity/free-text content — never allowed in props. */
const FORBIDDEN_PROP_KEYS = [
  'name', 'firstname', 'lastname', 'fullname', 'email', 'phone', 'tel', 'mobile',
  'address', 'street', 'zip', 'postal', 'dob', 'birth', 'ssn', 'mrn', 'nhs',
  'transcript', 'text', 'message', 'body', 'content', 'note', 'notes', 'reason',
  'patient', 'candidate', 'speaker', 'utterance', 'summary',
];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// 7+ consecutive digits (optionally separated) ≈ a phone / id-card / account no.
const PHONE_RE = /(?:\d[\s\-().]?){7,}/;

export type PropValue = string | number | boolean | null;
export type EventProps = Record<string, PropValue>;

export class PiiViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiiViolationError';
  }
}

/**
 * Assert a props bag is PII-free. Rejects forbidden key names, non-scalar values,
 * over-long strings (free text), and string values matching email/phone patterns.
 * Enum/short-code strings (≤64 chars, no email/phone shape) are allowed.
 * Throws `PiiViolationError` so the caller fails closed rather than leaking.
 */
export function assertPiiFree(props: EventProps | undefined): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    const lk = key.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_PROP_KEYS.some((f) => lk === f || lk.includes(f))) {
      throw new PiiViolationError(`product event prop "${key}" is a forbidden PII/PHI key`);
    }
    if (value === null) continue;
    const t = typeof value;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      throw new PiiViolationError(`product event prop "${key}" must be a scalar (got ${t})`);
    }
    if (t === 'string') {
      const s = value as string;
      if (s.length > 64) {
        throw new PiiViolationError(`product event prop "${key}" string exceeds 64 chars — looks like free text`);
      }
      if (EMAIL_RE.test(s)) throw new PiiViolationError(`product event prop "${key}" looks like an email address`);
      if (PHONE_RE.test(s)) throw new PiiViolationError(`product event prop "${key}" looks like a phone/account number`);
    }
  }
}
