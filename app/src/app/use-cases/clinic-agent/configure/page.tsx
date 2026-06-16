/**
 * /use-cases/clinic-agent/configure (SAU-297) — the no-code "Set up a demo" panel
 * for the AI Clinic Agent. Connect a clinic's Google Calendar (reusing the SAU-271
 * per-clinic OAuth flow) and set the phone numbers, so a call books into THAT
 * calendar. Auth-gated (the static explainer at /use-cases/clinic-agent stays
 * public); data is fetched per-actor and the interactive bits are a client island.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getStore } from '@/db';
import { requirePageActor } from '@/services/current-user';
import { toUseCaseLinks } from '@/services/use-cases';
import UseCaseShell from '@/components/UseCaseShell';
import { getCalendarConnectionView } from '@/services/calendar/calendar-connection';
import { getGoogleOAuthAppView } from '@/services/calendar/google-oauth-config';
import { getClinicPhoneView } from '@/services/clinic-phone';
import { getClinicConfigView } from '@/services/clinic-config';
import ClinicDemoConfig from './ClinicDemoConfig';
import type { ClinicConfigForm } from './ClinicDefinitionCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Set up a demo — AI Clinic Agent',
  description: "Connect a clinic's Google Calendar and phone numbers, then run a call that books into it.",
};

export default async function ClinicConfigurePage() {
  const store = getStore();
  const actor = await requirePageActor();

  // Derive the request origin for the OAuth redirect URI shown in the panel.
  const h = headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const origin = `${proto}://${host}`;

  const [calendarOAuth, oauthApp, phone, clinicConfig] = await Promise.all([
    getCalendarConnectionView(store, actor.userId),
    getGoogleOAuthAppView(store, actor.userId, origin),
    getClinicPhoneView(store, actor.userId),
    getClinicConfigView(store, actor.userId),
  ]);

  return (
    <UseCaseShell links={toUseCaseLinks()} activeSlug="clinic-agent">
      <nav className="docs-breadcrumb">
        <Link href="/use-cases">Use Cases</Link> <span aria-hidden="true">/</span>{' '}
        <Link href="/use-cases/clinic-agent">AI Clinic Agent</Link> <span aria-hidden="true">/</span> Set up a demo
      </nav>

      <ClinicDemoConfig
        calendarOAuth={calendarOAuth}
        oauthApp={oauthApp}
        phone={phone}
        clinicConfig={clinicConfig.config as unknown as ClinicConfigForm}
        clinicConfigured={clinicConfig.configured}
        isAdmin={actor.isAdmin}
      />
    </UseCaseShell>
  );
}
