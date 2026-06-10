/**
 * GET /s/{code} — share-link resolver (SAU-225). Resolves a short code to its
 * (public) scenario and redirects to the canonical scenario detail page. Unknown
 * or no-longer-public codes 404. This is the public entry point a shared link
 * lands on; the redirect keeps the canonical URL (`/scenarios/{slug}`) as the one
 * place the detail UI lives.
 */
import { notFound, redirect } from 'next/navigation';
import { getStore } from '@/db';
import { resolveShareCode } from '@/services/share';

export const dynamic = 'force-dynamic';

export default async function ShareResolverPage({ params }: { params: { code: string } }) {
  const scenario = await resolveShareCode(getStore(), params.code);
  if (!scenario) notFound();
  redirect(`/scenarios/${scenario.slug}`);
}
