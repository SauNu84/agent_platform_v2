/**
 * /use-cases/clinic-agent/dashboard (SAU-301, Phase 2 · WS-B) — the per-clinic
 * ops dashboard. Shows call outcomes (booked / no_slot / escalated), booking
 * accuracy, escalation + after-hours capture and PHI-safety for the ACTIVE clinic,
 * plus a clinic switcher to move between the clinics the operator runs. Auth-gated;
 * data is fetched per-actor server-side (RLS-scoped) and the interactive switcher
 * is a client island.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageActor } from '@/services/current-user';
import { toUseCaseLinks } from '@/services/use-cases';
import UseCaseShell from '@/components/UseCaseShell';
import ClinicDashboard from './ClinicDashboard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Ops dashboard — AI Clinic Agent',
  description: 'Per-clinic call outcomes, bookings, escalations and after-hours capture — the agent ROI.',
};

export default async function ClinicDashboardPage() {
  // Auth-gate the page; the metrics + switcher are loaded client-side from the API
  // (withActor) which binds app.clinic_id reliably under the app_rw role (SAU-275),
  // unlike an RSC enterWith data read.
  await requirePageActor();

  return (
    <UseCaseShell links={toUseCaseLinks()} activeSlug="clinic-agent">
      <nav className="docs-breadcrumb">
        <Link href="/use-cases">Use Cases</Link> <span aria-hidden="true">/</span>{' '}
        <Link href="/use-cases/clinic-agent">AI Clinic Agent</Link> <span aria-hidden="true">/</span> Ops dashboard
      </nav>

      <ClinicDashboard initialSwitcher={{ clinics: [], activeClinicId: null }} initialMetrics={null} />
    </UseCaseShell>
  );
}
