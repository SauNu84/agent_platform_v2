/**
 * Multi-clinic tenancy (SAU-301, Phase 2 · WS-B).
 *
 * An operator can belong to more than one clinic and switch the *active* clinic;
 * the active clinic drives the `app.clinic_id` RLS GUC (so sessions/outcomes/
 * notifications are scoped to it) and which authored definition the agent uses.
 *
 * The active selection is stored per-user in `user_setting` ({@link ACTIVE_CLINIC_KEY}).
 * Selecting a clinic is ALWAYS gated by membership — a stale or forged setting can
 * never widen access because (a) we re-check membership here before honoring it and
 * (b) the DB RLS policies (migration 0021) only ever match a member's own rows.
 */
import type { Store, ClinicRecord } from '@/db/store';

/** user_setting key holding the operator's currently-selected clinic id. */
export const ACTIVE_CLINIC_KEY = 'active_clinic';

export class TenancyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TenancyError';
    this.status = status;
  }
}

/** A slug-safe id from a clinic name (lowercase, dash-separated, deduped suffix added by caller). */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'clinic';
}

/** Clinics the operator may act for (the switcher list). */
export async function listClinics(store: Store, userId: string): Promise<ClinicRecord[]> {
  return store.listClinicsForUser(userId);
}

/**
 * Resolve the effective active clinic id for an operator: the stored selection if
 * it is still a valid membership, else the first clinic they belong to, else the
 * supplied fallback (their app_user.clinic_id / null). Pure read — no writes.
 */
export async function resolveActiveClinicId(
  store: Store,
  userId: string,
  fallbackClinicId: string | null,
): Promise<string | null> {
  // Cheap path for non-multi-clinic users: one query. If the user belongs to no
  // clinics, keep their default (app_user.clinic_id / null) and skip the rest.
  const clinics = await store.listClinicsForUser(userId);
  if (clinics.length === 0) return fallbackClinicId;
  const setting = await store.getUserSetting(userId, ACTIVE_CLINIC_KEY);
  const selected = typeof setting?.value?.clinicId === 'string' ? (setting.value.clinicId as string) : null;
  // Honor the selection only if it's still a clinic they belong to (the list proves
  // membership — no extra round-trip needed).
  if (selected && clinics.some((c) => c.id === selected)) return selected;
  return clinics[0].id;
}

/** Switch the active clinic (membership-gated). Returns the chosen clinic. */
export async function setActiveClinic(store: Store, userId: string, clinicId: string): Promise<ClinicRecord> {
  const clinic = await store.getClinicById(clinicId);
  if (!clinic || !(await store.isClinicMember(clinicId, userId))) {
    throw new TenancyError('Not a member of that clinic.', 403);
  }
  await store.putUserSetting(userId, ACTIVE_CLINIC_KEY, { clinicId });
  return clinic;
}

/**
 * Provision a new clinic owned by the operator: creates the clinic row (RLS self-
 * provision), adds the creator as an owner member, and makes it the active clinic.
 */
export async function createClinicForUser(
  store: Store,
  userId: string,
  name: string,
  config?: Record<string, unknown> | null,
): Promise<ClinicRecord> {
  const trimmed = name.trim();
  if (!trimmed) throw new TenancyError('Clinic name is required.');
  // Disambiguate the slug against the operator's existing clinics.
  const base = slugify(trimmed);
  const existing = await store.listClinicsForUser(userId);
  const taken = new Set(existing.map((c) => c.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  const clinic = await store.createClinic({ slug, name: trimmed, createdByUserId: userId, config: config ?? null });
  await store.addClinicMember(clinic.id, userId, 'owner');
  await store.putUserSetting(userId, ACTIVE_CLINIC_KEY, { clinicId: clinic.id });
  return clinic;
}

/** Client-safe summary of a clinic for the switcher. */
export interface ClinicSummary {
  id: string;
  slug: string;
  name: string;
  configured: boolean;
  active: boolean;
}

/** Build the switcher view: every clinic the operator belongs to + which is active. */
export async function getClinicSwitcherView(
  store: Store,
  userId: string,
  activeClinicId: string | null,
): Promise<{ clinics: ClinicSummary[]; activeClinicId: string | null }> {
  const clinics = await store.listClinicsForUser(userId);
  return {
    activeClinicId,
    clinics: clinics.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      configured: Boolean(c.config),
      active: c.id === activeClinicId,
    })),
  };
}
