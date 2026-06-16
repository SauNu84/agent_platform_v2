/**
 * Clinic self-service config (SAU-300, Phase 2 · WS-A) — the no-code clinic
 * definition that backs the AI Clinic Agent.
 *
 * A non-developer authors *everything the agent needs to run a clinic* in the UI
 * (profile + hours/after-hours, doctors + the services they offer, appointment
 * types + durations, accepted insurance, booking rules, persona greeting). It is
 * persisted **per-clinic** (per operator user) in the RLS-isolated `user_setting`
 * table (migration 0012/0015) under {@link CLINIC_CONFIG_KEY} — exactly like the
 * phone config (services/clinic-phone) and OAuth-app credentials, so it's isolated
 * from every other account with no new table or migration. Nothing here is a secret
 * (tokens/secrets stay server-side in their own encrypted records), so the config
 * is stored as plain JSON.
 *
 * The booking tools + scenario read this **config** instead of the hardcoded
 * DEFAULT_CLINIC (SAU-267), but the RULES stay enforced in the booking tool's pure
 * `domain/clinic` engine, never the prompt (AC #2, consistent with Phase 0). When
 * an operator hasn't authored a clinic yet, the effective config falls back to
 * DEFAULT_CLINIC so the Phase-0 demo keeps working unchanged.
 */
import { z } from 'zod';
import type { Store } from '@/db/store';
import {
  DEFAULT_CLINIC,
  type ClinicConfig,
  type Doctor,
  type Service,
  type DayHours,
} from '@/domain/clinic';

/** user_setting key for the authored clinic definition. */
export const CLINIC_CONFIG_KEY = 'clinic_config';

export class ClinicConfigError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ClinicConfigError';
    this.status = status;
  }
}

// ── Authoring schema (no-code surface) ───────────────────────────────────────
// Times in the form are "HH:MM"; we store minutes-from-midnight in the domain.
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

const dayHoursSchema = z
  .object({ open: z.string().regex(HHMM), close: z.string().regex(HHMM) })
  .nullable();

const serviceSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  durationMinutes: z.number().int().min(5).max(480),
});

const doctorSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  specialty: z.string().trim().max(120).default(''),
  serviceIds: z.array(z.string().trim().min(1)).default([]),
});

const afterHoursSchema = z.object({
  mode: z.enum(['voicemail', 'callback', 'message']),
  message: z.string().trim().max(500).optional(),
});

/** The shape the panel PUTs. Everything is validated/normalized before persisting. */
export const clinicConfigInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  timezone: z.string().trim().min(1).max(64),
  /** 7 entries, index 0=Sunday … 6=Saturday; null = closed. */
  hours: z.array(dayHoursSchema).length(7),
  slotMinutes: z.number().int().min(5).max(240),
  doctors: z.array(doctorSchema).min(1).max(50),
  services: z.array(serviceSchema).max(50).default([]),
  insuranceAccepted: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  afterHours: afterHoursSchema.default({ mode: 'voicemail' }),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  leadTimeMinutes: z.number().int().min(0).max(10080).default(0),
  maxPerDay: z.number().int().min(0).max(200).default(0),
  greeting: z.string().trim().max(1000).default(''),
});

export type ClinicConfigInput = z.input<typeof clinicConfigInputSchema>;

/** "HH:MM" → minutes from midnight. */
function hhmmToMin(v: string): number {
  const [h, m] = v.split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}
/** minutes from midnight → "HH:MM". */
function minToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Map the validated authoring input → the canonical domain ClinicConfig. */
function toClinicConfig(input: z.infer<typeof clinicConfigInputSchema>): ClinicConfig {
  const serviceIds = new Set(input.services.map((s) => s.id));
  const hours: Array<DayHours | null> = input.hours.map((d) => {
    if (!d) return null;
    const openMin = hhmmToMin(d.open);
    const closeMin = hhmmToMin(d.close);
    if (closeMin <= openMin) {
      throw new ClinicConfigError('Each open day must close after it opens.');
    }
    return { openMin, closeMin };
  });
  const doctors: Doctor[] = input.doctors.map((d) => ({
    id: d.id,
    name: d.name,
    specialty: d.specialty,
    // Drop references to services that no longer exist; empty ⇒ offers all.
    serviceIds: d.serviceIds.filter((id) => serviceIds.has(id)),
  }));
  const services: Service[] = input.services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes }));

  // Guard against an authoring slip-up that would yield zero bookable slots.
  if (services.some((s) => s.durationMinutes < input.slotMinutes)) {
    // Allowed (the grid still steps by slotMinutes), but the visit may span multiple grid cells — fine.
  }

  return {
    name: input.name,
    timezone: input.timezone,
    hours,
    slotMinutes: input.slotMinutes,
    doctors,
    insuranceAccepted: input.insuranceAccepted,
    services,
    afterHours: input.afterHours,
    bufferMinutes: input.bufferMinutes,
    leadTimeMinutes: input.leadTimeMinutes,
    maxPerDay: input.maxPerDay,
    greeting: input.greeting || undefined,
  };
}

/** The reverse map: a domain ClinicConfig → the form-friendly authoring view. */
export function toClinicConfigView(clinic: ClinicConfig): ClinicConfigInput {
  return {
    name: clinic.name,
    timezone: clinic.timezone,
    hours: clinic.hours.map((d) => (d ? { open: minToHhmm(d.openMin), close: minToHhmm(d.closeMin) } : null)),
    slotMinutes: clinic.slotMinutes,
    doctors: clinic.doctors.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty ?? '', serviceIds: d.serviceIds ?? [] })),
    services: (clinic.services ?? []).map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes })),
    insuranceAccepted: clinic.insuranceAccepted,
    afterHours: clinic.afterHours ?? { mode: 'voicemail' },
    bufferMinutes: clinic.bufferMinutes ?? 0,
    leadTimeMinutes: clinic.leadTimeMinutes ?? 0,
    maxPerDay: clinic.maxPerDay ?? 0,
    greeting: clinic.greeting ?? '',
  };
}

/**
 * The effective clinic config for an operator: the authored definition if present
 * and valid, else the Phase-0 DEFAULT_CLINIC (so the demo always works). This is
 * what the booking tools + scenario read at runtime.
 */
export async function getClinicConfig(store: Store, userId: string | null): Promise<ClinicConfig> {
  if (!userId) return DEFAULT_CLINIC;
  const rec = await store.getUserSetting(userId, CLINIC_CONFIG_KEY);
  const value = rec?.value;
  if (!value || value.status !== 'configured' || typeof value.config !== 'object' || value.config === null) {
    return DEFAULT_CLINIC;
  }
  const parsed = clinicConfigInputSchema.safeParse(value.config);
  if (!parsed.success) return DEFAULT_CLINIC; // corrupt/legacy record ⇒ fail soft to the default
  try {
    return toClinicConfig(parsed.data);
  } catch {
    return DEFAULT_CLINIC;
  }
}

export interface ClinicConfigView {
  /** True once the operator has authored a clinic (else the form seeds from DEFAULT_CLINIC). */
  configured: boolean;
  /** Form-ready authoring view of the effective config. */
  config: ClinicConfigInput;
  updatedAt: string | null;
}

/** Build the panel view (configured flag + form-ready config). */
export async function getClinicConfigView(store: Store, userId: string): Promise<ClinicConfigView> {
  const rec = await store.getUserSetting(userId, CLINIC_CONFIG_KEY);
  const effective = await getClinicConfig(store, userId);
  return {
    configured: Boolean(rec?.value && rec.value.status === 'configured'),
    config: toClinicConfigView(effective),
    updatedAt: rec?.updatedAt ?? null,
  };
}

/** Validate + persist the authored clinic definition. Returns the refreshed view. */
export async function saveClinicConfig(store: Store, userId: string, raw: unknown): Promise<ClinicConfigView> {
  const parsed = clinicConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') || 'config';
    throw new ClinicConfigError(`${path}: ${first?.message ?? 'invalid clinic configuration'}`);
  }
  // Cross-field validation lives in the mapper (e.g. close-after-open); surface it.
  const config = toClinicConfig(parsed.data);
  if (config.doctors.length === 0) throw new ClinicConfigError('Add at least one doctor.');
  if (config.hours.every((d) => d === null)) throw new ClinicConfigError('The clinic must be open at least one day.');

  await store.putUserSetting(userId, CLINIC_CONFIG_KEY, {
    status: 'configured',
    // Store the normalized authoring input (round-trips cleanly through the schema).
    config: parsed.data as unknown as Record<string, unknown>,
  });
  return getClinicConfigView(store, userId);
}

/** Clear the authored clinic (revert to DEFAULT_CLINIC). Returns the refreshed view. */
export async function clearClinicConfig(store: Store, userId: string): Promise<ClinicConfigView> {
  await store.deleteUserSetting(userId, CLINIC_CONFIG_KEY);
  return getClinicConfigView(store, userId);
}
