/**
 * Inbound-call admission (SAU-525) — the per-tenant seam the telephony bridge was
 * missing. Before the bridge answers a call it must know THREE things it could not
 * know before: which tenant the call belongs to, who pays for it, and which engine
 * to run it on. Until now it knew none of them (engine from a global env var,
 * `userId: null`, no cap, no usage row), so every phone minute was billed at the
 * premium rate to nobody. This module answers all three in one place:
 *
 *   dialed number (`To`) ──▶ clinic (clinic.phone_number, migration 0027)
 *                            ├─▶ owner user  = the billing PRINCIPAL (tier, cap, usage)
 *                            ├─▶ engine      = clinic.voice_engine grade → router
 *                            └─▶ actor ctx   = { owner, clinic } so every row the call
 *                                              writes is RLS-scoped to the tenant
 *
 * Fail-closed: a number that resolves to no tenant, a tenant with no owner, or an
 * owner over their monthly cap is REFUSED with a typed reason — the bridge never
 * falls back to an unmetered call. The only fallback is `fallbackClinicSlug` (env
 * `TELEPHONY_FALLBACK_CLINIC`), which still resolves to a tenant + owner and is
 * therefore still metered; it exists so a single dev/trial number can be exercised
 * without binding it, never as a route around the meter.
 *
 * The tenant lookup runs under a SYSTEM actor (admin GUC) because an inbound PSTN
 * webhook has no user principal and the clinic RLS policies hide every row from an
 * unbound request. That privilege is scoped to this function; the call itself runs
 * under the OWNER's context (`admission.actor`), which the bridge binds explicitly.
 *
 * Pure over the Store interface — unit-tests with MemoryStore, no network.
 */
import type { Store, ClinicRecord, ClinicPayer } from '@/db/store';
import { runWithActor, type ActorContext } from '@/auth/actor';
import { resolveTierForUser, resolveTenantEngine, type TenantEngine, type VoiceTier } from '@/voice/engine-router';
import { assertWithinCap, CapExceededError, type MeterState } from '@/services/meter';

/**
 * The bridge's lookup identity. Same shape as the seed CLI's system actor: a nil
 * user id (matches no owner row) + the admin GUC (bypasses the clinic read policy).
 */
export const BRIDGE_SYSTEM_ACTOR: ActorContext = {
  userId: '00000000-0000-0000-0000-000000000000',
  isAdmin: true,
  clinicId: null,
};

export type AdmissionReason =
  | 'no_number'      // the webhook did not tell us which number was dialed
  | 'no_tenant'      // no clinic is bound to that number (and no fallback)
  | 'no_owner'       // the clinic has no current owner-role member to bill
  | 'cap_exceeded';  // the owner has spent this month's voice minutes

export class CallAdmissionError extends Error {
  constructor(public reason: AdmissionReason, message: string, public meter?: MeterState) {
    super(message);
    this.name = 'CallAdmissionError';
  }
}

export interface CallAdmission {
  clinic: ClinicRecord;
  /** the billing principal every row of this call is attributed to */
  ownerUserId: string;
  /** the owner's BILLING tier (what the usage row is metered at) */
  tier: VoiceTier;
  /** the engine the call runs on (tenant grade → concrete model) */
  engine: TenantEngine;
  /** the owner's meter state at admission (pre-flight, same as the web Join) */
  meter: MeterState;
  /** RLS context the bridge must bind for the whole call */
  actor: ActorContext;
  /** how the tenant was found — surfaced in logs so a fallback is never silent */
  resolvedBy: 'phone_number' | 'fallback_slug';
  /** how the payer was found; 'earliest_owner' with a creator set ⇒ creator was skipped */
  payerResolvedBy: ClinicPayer['source'];
}

/** E.164 as Twilio sends it: a leading + and 7–15 digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Normalize a dialed number to E.164: strip formatting only. The leading `+` is
 * REQUIRED — Twilio always sends it, and inventing one for a bare national number
 * would silently re-home it (a US "415…" becomes Swiss "+41 5…"). Null if unusable.
 */
export function normalizeDialedNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().replace(/[\s().-]/g, '');
  return E164.test(v) ? v : null;
}

export interface AdmitInboundCallOptions {
  /** the dialed number from the webhook (`To`); may be raw — normalized here */
  to: string | null | undefined;
  /** scenario's chosen engine id (metadata._model), honoured like the web path */
  modelId?: string | null;
  /** dev/trial escape hatch — a clinic SLUG to bill when the number is unbound (still metered) */
  fallbackClinicSlug?: string | null;
}

/** Resolve tenant + payer + engine for an inbound call, or throw a typed refusal. */
export async function admitInboundCall(store: Store, opts: AdmitInboundCallOptions): Promise<CallAdmission> {
  const to = normalizeDialedNumber(opts.to);
  const fallback = opts.fallbackClinicSlug?.trim() || null;
  if (!to && !fallback) throw new CallAdmissionError('no_number', 'inbound call carried no dialed number');

  return runWithActor(BRIDGE_SYSTEM_ACTOR, async () => {
    let clinic: ClinicRecord | null = to ? await store.getClinicByPhoneNumber(to) : null;
    let resolvedBy: CallAdmission['resolvedBy'] = 'phone_number';
    if (!clinic && fallback) {
      clinic = await store.getClinicBySlug(fallback);
      resolvedBy = 'fallback_slug';
    }
    if (!clinic) {
      throw new CallAdmissionError('no_tenant', `no clinic is bound to ${to ?? '(no number)'}`);
    }

    // Only a CURRENT owner-role member is ever charged (CTO condition): a creator
    // who left or was downgraded falls through to the earliest owner, else refuse.
    const payer = await store.getClinicPayer(clinic.id);
    if (!payer) {
      throw new CallAdmissionError('no_owner', `clinic ${clinic.slug} has no current owner to bill`);
    }
    const ownerUserId = payer.userId;

    // Same pre-flight the web Join runs (Slice 2): refuse when the month is spent.
    let meter: MeterState;
    try {
      meter = await assertWithinCap(store, ownerUserId);
    } catch (e) {
      if (e instanceof CapExceededError) throw new CallAdmissionError('cap_exceeded', e.message, e.state);
      throw e;
    }

    const tier = await resolveTierForUser(store, ownerUserId);
    const engine = resolveTenantEngine({ modelId: opts.modelId, tier, grade: clinic.voiceEngine });

    return {
      clinic,
      ownerUserId,
      tier,
      engine,
      meter,
      actor: { userId: ownerUserId, isAdmin: false, clinicId: clinic.id },
      resolvedBy,
      payerResolvedBy: payer.source,
    };
  });
}
