/**
 * Share-link service (SAU-225) — the use-case layer over the Store's share-link
 * methods. Two operations:
 *   - shareScenario:    mint (or return the existing) short code for a scenario.
 *   - resolveShareCode: code → scenario, for the GET /s/{code} resolver.
 *
 * Privacy gate: only PUBLIC scenarios are shareable (a share link is a public,
 * unauthenticated entry point). Sharing a private scenario throws
 * ShareNotAllowedError so the API can answer 403 with a clear note; the resolver
 * also re-checks visibility at read time, so a scenario flipped to private after
 * a link was minted stops resolving.
 */
import type { ScenarioRecord, ShareLinkRecord, Store } from '@/db/store';
import { isShareCode } from '@/lib/short-code';

export class ShareNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareNotAllowedError';
  }
}

export interface ShareResult {
  code: string;
  /** Site-relative share path, e.g. `/s/ab12CD34`. */
  path: string;
}

/** Mint (or return the existing) share link for a scenario by slug. */
export async function shareScenario(store: Store, slug: string): Promise<ShareResult | null> {
  const scenario = await store.getScenarioBySlug(slug);
  if (!scenario) return null;
  if (!scenario.isPublic) {
    throw new ShareNotAllowedError('Only public scenarios can be shared. Make this scenario public to create a link.');
  }
  const link = await store.createShareLink(scenario.id);
  return { code: link.code, path: `/s/${link.code}` };
}

/** Resolve a share code to its (still-public) scenario, or null. */
export async function resolveShareCode(store: Store, code: string): Promise<ScenarioRecord | null> {
  if (!isShareCode(code)) return null;
  const link: ShareLinkRecord | null = await store.getShareLinkByCode(code);
  if (!link) return null;
  const scenario = await store.getScenarioById(link.scenarioId);
  if (!scenario || !scenario.isPublic) return null;   // gone or no longer public
  return scenario;
}
