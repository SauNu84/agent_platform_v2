/**
 * /use-cases/call-center-agent/dashboard (SAU-335, WS-4) — the per-lender collections
 * ops dashboard. Shows cadence + next-eligible-dial, the suppression / opt-out list,
 * compliance-block counts and the read-only guardrail-10 audit trail for the ACTIVE
 * lender, plus a lender switcher to move between the lenders the operator runs.
 * Auth-gated; data is fetched per-actor from the API (RLS-scoped) and the interactive
 * switcher is a client island. Synthetic debtors only.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageActor } from '@/services/current-user';
import { toUseCaseLinks } from '@/services/use-cases';
import UseCaseShell from '@/components/UseCaseShell';
import CollectionsDashboard from './CollectionsDashboard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Ops dashboard — AI Call Center Agent',
  description: 'Per-lender cadence, next-eligible dial, suppression list and compliance audit trail — the collections agent guardrails in view.',
};

export default async function CollectionsDashboardPage() {
  // Auth-gate the page; the metrics + switcher load client-side from the API (withActor),
  // which binds app.clinic_id reliably under the app_rw role (SAU-275) unlike an RSC read.
  await requirePageActor();

  return (
    <UseCaseShell links={toUseCaseLinks()} activeSlug="call-center-agent">
      <nav className="docs-breadcrumb">
        <Link href="/use-cases">Use Cases</Link> <span aria-hidden="true">/</span>{' '}
        <Link href="/use-cases/call-center-agent">AI Call Center Agent</Link> <span aria-hidden="true">/</span> Ops dashboard
      </nav>

      <CollectionsDashboard initialSwitcher={{ clinics: [], activeClinicId: null }} initialMetrics={null} />
    </UseCaseShell>
  );
}
