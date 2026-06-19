/**
 * Clinic Secretary TOP-OF-FUNNEL product events (SAU-359, WS5 §6).
 *
 * The UPPER half of the clinic funnel — the bottom/value half (session /
 * booking / confirmation / escalation) is already wired at finalizeClinicSession
 * (SAU-358, services/clinic-session.ts). These three events ride the WS3
 * commercial-UX seams (SAU-348) and are emitted through `trackSafe()` (best-effort,
 * never breaks the page) at seams that already hold `store` + the actor's tenant
 * (`clinicId` → product_event.tenant_id):
 *
 *   - clinic.demo.viewed       — the per-clinic demo/ops view (dashboard page)
 *   - clinic.setup.started     — entering the "Set up a demo" wizard (configure page)
 *   - clinic.calendar.connected — the Google Calendar connect callback (ACTIVATION ★;
 *                                 a clinic with no calendar cannot book)
 *
 * Props are enum/count/bool ONLY. The `track()` PII guard (assertPiiFree) fails
 * closed on identity/free-text — including any key that merely *contains* a
 * forbidden token. Two traps avoided here: the setup-progress flag is keyed
 * `numbers_configured` (NOT "phone…", a forbidden token), and the calendar is
 * reported as the enum `target` ('primary' | 'custom') — never the raw calendar
 * id, which can be an email-shaped address (e.g. clinic@group.calendar.google.com).
 */
import type { Store } from '@/db/store';
import { trackSafe } from '@/services/product-analytics';
import { PRODUCT_EVENTS } from '@/domain/analytics-events';

/** The tenant-bearing identity slice every clinic funnel event carries. */
export interface ClinicFunnelActor {
  /** internal user uuid — a cohort id, NOT a name/email/phone. */
  actorId: string | null;
  /** owning clinic uuid → product_event.tenant_id; null = no active clinic. */
  clinicId: string | null;
}

/** `clinic.demo.viewed` — operator viewed the per-clinic demo / ops surface. */
export async function emitClinicDemoViewed(store: Store, ctx: ClinicFunnelActor): Promise<void> {
  await trackSafe(store, {
    event: PRODUCT_EVENTS.CLINIC_DEMO_VIEWED,
    surface: 'web',
    actorId: ctx.actorId,
    tenantId: ctx.clinicId,
    props: { has_clinic: ctx.clinicId !== null },
  });
}

/** `clinic.setup.started` — operator entered the "Set up a demo" wizard. */
export async function emitClinicSetupStarted(
  store: Store,
  ctx: ClinicFunnelActor & {
    calendarConnected: boolean;
    oauthConfigured: boolean;
    clinicConfigured: boolean;
    numbersConfigured: boolean;
  },
): Promise<void> {
  await trackSafe(store, {
    event: PRODUCT_EVENTS.CLINIC_SETUP_STARTED,
    surface: 'web',
    actorId: ctx.actorId,
    tenantId: ctx.clinicId,
    // Setup-progress snapshot — bools only. `numbers_configured`, NOT "phone…",
    // to clear the track() PII guard's forbidden-token check.
    props: {
      calendar_connected: ctx.calendarConnected,
      oauth_configured: ctx.oauthConfigured,
      clinic_configured: ctx.clinicConfigured,
      numbers_configured: ctx.numbersConfigured,
    },
  });
}

/** `clinic.calendar.connected` — ACTIVATION ★: the clinic linked its booking calendar. */
export async function emitClinicCalendarConnected(
  store: Store,
  ctx: ClinicFunnelActor & { calendarId: string | null; fromDemoConfig: boolean },
): Promise<void> {
  await trackSafe(store, {
    event: PRODUCT_EVENTS.CLINIC_CALENDAR_CONNECTED,
    surface: 'web',
    actorId: ctx.actorId,
    tenantId: ctx.clinicId,
    props: {
      provider: 'google',
      // enum, NEVER the raw id (a calendar id can be an email-shaped address).
      target: ctx.calendarId && ctx.calendarId !== 'primary' ? 'custom' : 'primary',
      from_demo_config: ctx.fromDemoConfig,
    },
  });
}
