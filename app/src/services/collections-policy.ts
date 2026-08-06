/**
 * collections-policy.ts (SAU-521 · SAU-331 gate item 2) — the loading path for the
 * per-lender collections policy.
 *
 * WHAT WAS BROKEN. `TenantCollectionsConfig` (domain/collections-engine) was an
 * enforcement seam with no supply side. `allowedStates` appeared in exactly two files on
 * `main` — the engine and the engine's own unit test — so no production caller could
 * ever set it. The state-licensing gate was unreachable code, and because the engine
 * then read "absent list" as "gate off", an unconfigured tenant dialed every state
 * including `null`/unknown. Same class as SAU-289: a setting that never reaches the
 * thing it is supposed to govern.
 *
 * THIS MODULE IS THE MISSING HALF. It turns a persisted `collections_policy` row
 * (migration 0026) into the `TenantCollectionsConfig` the engine consumes, and it is the
 * single place that conversion happens — dialer and dashboard both call
 * {@link loadTenantCollectionsConfig}, so the dashboard's "when next" cannot disagree
 * with what the dialer will actually do.
 *
 * FAIL-CLOSED CONTRACT. A missing row and an empty allow-list are the SAME state here:
 * not configured. This module never invents a fallback allow-list — it returns the empty
 * one and lets the engine block with `licensing_unconfigured`. Do not add a default:
 * which states we are licensed in is counsel's call (SAU-354 §9 Q3), and a plausible
 * guess is worse than a stopped queue.
 */
import { z } from 'zod';
import type { Store } from '@/db/store';
import type { CollectionsPolicyRecord } from '@/domain/collections';
import type { TenantCollectionsConfig, StateCallCap } from '@/domain/collections-engine';

export class CollectionsPolicyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CollectionsPolicyError';
    this.status = status;
  }
}

// ── Authoring schema (the no-code surface behind the settings route) ─────────

/**
 * USPS 2-letter state code. Normalised to uppercase on the way in so the stored value
 * matches what the engine compares against, and a lowercase `ca` can never become a
 * silent no-match that quietly excludes California.
 */
const stateCode = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'state must be a 2-letter code, e.g. CA'));

const stateCapSchema = z.object({
  maxAttempts: z.number().int().min(0).max(50),
  windowDays: z.number().int().min(1).max(90),
});

export const collectionsPolicyInputSchema = z.object({
  /**
   * The licensed-state allow-list. Deduplicated because a duplicate entry is an
   * operator slip, not a stronger permission.
   */
  allowedStates: z
    .array(stateCode)
    .max(60)
    .transform((list) => [...new Set(list)].sort())
    .optional(),
  /** Stricter-only per-state caps. Keys are normalised to uppercase for the same reason. */
  stateCaps: z
    .record(z.string(), stateCapSchema)
    .optional()
    .transform((caps) => {
      if (!caps) return undefined;
      const out: Record<string, StateCallCap> = {};
      for (const [k, v] of Object.entries(caps)) {
        const key = k.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(key)) {
          throw new CollectionsPolicyError(`stateCaps key "${k}" must be a 2-letter state code`);
        }
        out[key] = v;
      }
      return out;
    }),
});

export type CollectionsPolicyAuthoringInput = z.input<typeof collectionsPolicyInputSchema>;

/** Parse + normalise an authoring payload, raising {@link CollectionsPolicyError} on bad shape. */
export function parseCollectionsPolicyInput(raw: unknown): z.output<typeof collectionsPolicyInputSchema> {
  const parsed = collectionsPolicyInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CollectionsPolicyError(
      `invalid collections policy: ${first?.path.join('.') || 'body'} — ${first?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

// ── Loading ─────────────────────────────────────────────────────────────────

/** Project a persisted policy row onto the engine's config shape. */
export function toTenantConfig(policy: CollectionsPolicyRecord | null): TenantCollectionsConfig {
  if (!policy) return { allowedStates: [], stateCaps: {} };
  return { allowedStates: policy.allowedStates, stateCaps: policy.stateCaps };
}

/**
 * Load the effective engine config for one lender tenant.
 *
 * Returns `{ allowedStates: [] }` when no policy row exists — deliberately NOT an empty
 * object. Both read the same way to the post-SAU-521 engine (block), but returning the
 * explicit empty list keeps the intent visible at the call site: this tenant is not
 * cleared to dial, rather than "we forgot to pass a config".
 */
export async function loadTenantCollectionsConfig(
  store: Store,
  clinicId: string,
): Promise<TenantCollectionsConfig> {
  return toTenantConfig(await store.getCollectionsPolicy(clinicId));
}

/** Write a lender's policy and return the stored result. */
export async function saveTenantCollectionsPolicy(
  store: Store,
  clinicId: string,
  raw: unknown,
  updatedBy?: string | null,
): Promise<CollectionsPolicyRecord> {
  const input = parseCollectionsPolicyInput(raw);
  return store.upsertCollectionsPolicy({
    clinicId,
    allowedStates: input.allowedStates,
    stateCaps: input.stateCaps,
    updatedBy: updatedBy ?? null,
  });
}

// ── Go-live preflight (SAU-521 AC 4a) ───────────────────────────────────────

/** One unmet precondition for enabling live dialing on a tenant. */
export interface CollectionsPreflightFailure {
  /** Stable machine code — mirrors the engine's block code where they correspond. */
  code: 'licensing_unconfigured';
  /** Operator-facing remediation, not just a diagnosis. */
  message: string;
}

export interface CollectionsPreflightResult {
  ok: boolean;
  clinicId: string;
  failures: CollectionsPreflightFailure[];
}

/**
 * Check whether a tenant may be switched to live dialing.
 *
 * This is the EARLY, FRIENDLY failure — it exists so an operator finds out at onboarding
 * that the allow-list is missing, instead of discovering it as a queue that silently
 * dials nobody. It is explicitly NOT the control: a preflight is a point-in-time check
 * on a property that must hold continuously, and it cannot cover a tenant that passes
 * here and later has its allow-list cleared by a settings edit, migration, restore, or
 * bug. The control is the engine invariant (`licensing_unconfigured`), which every dial
 * re-evaluates. Deleting the engine check and keeping this one would reopen SAU-521.
 *
 * Scope: `allowedStates` only. `stateCaps` and `holidays` are stricter-only layers above
 * an enforced floor (Reg-F 7-in-7 is a hard constant; DEFAULT_US_HOLIDAYS is built in),
 * so unconfigured is already safe for them and blocking on them would be noise.
 */
export async function preflightCollectionsGoLive(
  store: Store,
  clinicId: string,
): Promise<CollectionsPreflightResult> {
  const config = await loadTenantCollectionsConfig(store, clinicId);
  const failures: CollectionsPreflightFailure[] = [];

  if (!config.allowedStates || config.allowedStates.length === 0) {
    failures.push({
      code: 'licensing_unconfigured',
      message:
        'No state licensing allow-list is configured for this tenant, so every dial would be blocked. ' +
        'Set the collections policy `allowedStates` to the states this lender is licensed to collect in ' +
        '(counsel-supplied — SAU-354 §9 Q3) before enabling live dialing.',
    });
  }

  return { ok: failures.length === 0, clinicId, failures };
}

/**
 * Preflight, but throwing — for call sites that are ENABLING live dialing and must not
 * proceed on a failure. Kept separate from the reporting form so a settings UI can show
 * the failures without an exception.
 */
export async function assertCollectionsGoLiveReady(store: Store, clinicId: string): Promise<void> {
  const result = await preflightCollectionsGoLive(store, clinicId);
  if (!result.ok) {
    throw new CollectionsPolicyError(
      `collections go-live preflight failed for tenant ${clinicId}: ` +
        result.failures.map((f) => `[${f.code}] ${f.message}`).join(' '),
      409,
    );
  }
}
