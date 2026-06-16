/**
 * Clinic demo phone configuration (SAU-297) — the per-clinic phone numbers used by
 * the AI Clinic Agent demo: the **agent number** patients call (defaults to the
 * live trial number, +14783754797) and an optional **clinic handoff number** the
 * agent warm-transfers to when a human is needed (SAU-273 escalation seam).
 *
 * Persisted per-user (the clinic owner/operator) in the RLS-protected `user_setting`
 * table (migration 0012/0015) under {@link CLINIC_PHONE_KEY}, exactly like the other
 * Settings integrations (services/settings.ts). No secrets here — phone numbers are
 * not credentials; the Twilio account SID/auth token stay in env (twilio-config.ts).
 *
 * Resolution for the effective agent number: the saved value, else the env
 * `TWILIO_PHONE_NUMBER`, else the platform default trial number. This mirrors the
 * env-first pattern of {@link resolveTwilioConfig} so the demo panel and the live
 * bridge agree on which number is in play.
 */
import type { Store } from '@/db/store';
import type { PhoneIntegrationSetting } from '@/services/telephony';

/** The live Twilio trial number provisioned for the clinic agent (SAU-292/293). */
export const DEFAULT_AGENT_NUMBER = '+14783754797';

/** user_setting key for the clinic demo phone config (distinct from the SAU-253
 *  `integration:phone` provider-choice record so neither clobbers the other). */
export const CLINIC_PHONE_KEY = 'clinic_demo_phone';

export class ClinicPhoneError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ClinicPhoneError';
    this.status = status;
  }
}

export interface ClinicPhoneConfig {
  /** E.164 number patients call to reach the agent. */
  agentNumber: string;
  /** Optional E.164 number the agent warm-transfers to for a human handoff. */
  clinicHandoffNumber: string | null;
}

/** Client-safe view for the demo configuration panel. */
export interface ClinicPhoneView {
  /** The saved agent number, or null when never configured. */
  agentNumber: string | null;
  /** The saved clinic handoff number, or null. */
  clinicHandoffNumber: string | null;
  /** The platform default trial number, shown as the suggested agent number. */
  defaultAgentNumber: string;
  /** True once the operator has saved a config. */
  configured: boolean;
  /** When an env `TWILIO_PHONE_NUMBER` is set it takes precedence (informational). */
  envAgentNumber: string | null;
  updatedAt: string | null;
}

/** E.164: a leading + and 7–15 digits (first digit non-zero). */
const E164 = /^\+[1-9]\d{6,14}$/;

function normalizeNumber(raw: unknown, label: string, required: boolean): string | null {
  const value = typeof raw === 'string' ? raw.trim().replace(/[\s()-]/g, '') : '';
  if (!value) {
    if (required) throw new ClinicPhoneError(`${label} is required.`);
    return null;
  }
  if (!E164.test(value)) {
    throw new ClinicPhoneError(`${label} must be in E.164 format, e.g. ${DEFAULT_AGENT_NUMBER}.`);
  }
  return value;
}

/** Read the saved demo phone config (no defaults filled in), or null. */
export async function getClinicPhoneConfig(store: Store, userId: string): Promise<ClinicPhoneConfig | null> {
  const rec = await store.getUserSetting(userId, CLINIC_PHONE_KEY);
  const value = rec?.value;
  if (!value || value.status !== 'configured' || typeof value.agentNumber !== 'string') return null;
  return {
    agentNumber: value.agentNumber,
    clinicHandoffNumber: typeof value.clinicHandoffNumber === 'string' ? value.clinicHandoffNumber : null,
  };
}

/** The effective agent number for the demo: saved → env → default trial number. */
export async function resolveAgentNumber(store: Store, userId: string): Promise<string> {
  const cfg = await getClinicPhoneConfig(store, userId);
  return cfg?.agentNumber || process.env.TWILIO_PHONE_NUMBER || DEFAULT_AGENT_NUMBER;
}

/** Build the panel view (saved values + the suggested default + env precedence). */
export async function getClinicPhoneView(store: Store, userId: string): Promise<ClinicPhoneView> {
  const rec = await store.getUserSetting(userId, CLINIC_PHONE_KEY);
  const cfg = await getClinicPhoneConfig(store, userId);
  return {
    agentNumber: cfg?.agentNumber ?? null,
    clinicHandoffNumber: cfg?.clinicHandoffNumber ?? null,
    defaultAgentNumber: DEFAULT_AGENT_NUMBER,
    configured: Boolean(cfg),
    envAgentNumber: process.env.TWILIO_PHONE_NUMBER || null,
    updatedAt: rec?.updatedAt ?? null,
  };
}

/** Validate + persist the demo phone config. Returns the refreshed view. */
export async function saveClinicPhoneConfig(
  store: Store,
  userId: string,
  raw: { agentNumber?: unknown; clinicHandoffNumber?: unknown },
): Promise<ClinicPhoneView> {
  const agentNumber = normalizeNumber(raw.agentNumber, 'Agent number', true)!;
  const clinicHandoffNumber = normalizeNumber(raw.clinicHandoffNumber, 'Clinic handoff number', false);
  await store.putUserSetting(userId, CLINIC_PHONE_KEY, {
    status: 'configured',
    agentNumber,
    clinicHandoffNumber,
  });
  return getClinicPhoneView(store, userId);
}

/** Clear the demo phone config (revert to env/default). Returns the refreshed view. */
export async function clearClinicPhoneConfig(store: Store, userId: string): Promise<ClinicPhoneView> {
  await store.deleteUserSetting(userId, CLINIC_PHONE_KEY);
  return getClinicPhoneView(store, userId);
}

/**
 * Map the saved demo config onto a {@link PhoneIntegrationSetting} so the telephony
 * factory ({@link resolveTwilioConfig}) can fold the configured agent number into
 * the live bridge config (single-tenant demo). Env still takes precedence. Returns
 * null when nothing is configured so the caller keeps the env-only path.
 */
export async function toPhoneIntegrationSetting(
  store: Store,
  userId: string,
): Promise<PhoneIntegrationSetting | null> {
  const cfg = await getClinicPhoneConfig(store, userId);
  if (!cfg) return null;
  return { status: 'configured', twilioPhoneNumber: cfg.agentNumber };
}
