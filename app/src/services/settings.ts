/**
 * Settings service (SAU-253) — the data behind the Settings hub (under Billing).
 *
 * The hub has these tabs; only the preference-style ones persist through this
 * service (the rest reuse existing services):
 *   • Account          → read-only, aggregated here from app_user + entitlement.
 *   • Language         → preferred language for AI conversation (persisted).
 *   • Memory           → reuses coach_memory (ADR-004); surfaced read-only.
 *   • Knowledge Bases  → reuses services/knowledge-base.ts.
 *   • My Voice         → a voice-profile config (persisted; synthesis activation
 *                        via Cartesia is a follow-up — status reflects that).
 *   • Integrations     → per-connection config for Phone (SIP trunk), Calendar,
 *                        and MCP tools (persisted; live execution is a follow-up).
 *
 * Language / My Voice / Integrations all persist through the generic per-user
 * key/value `user_setting` table (migration 0012). Values are small config blobs
 * scoped to the authenticated actor's userId at the application layer (same model
 * as billing/dev-tools).
 *
 * ONE exception stores a secret: the live-voice (Gemini) API key (SAU-259), so
 * the board can self-provision the key from Settings → My Voice without editing
 * env files ("Check the setting"). It is POC-grade: the raw key is read ONLY
 * server-side (the realtime token route, which mints an ephemeral browser token —
 * the key never reaches the client) and is NEVER echoed back to any client (only
 * a masked last-4 view). Production should move this to env / a secret manager.
 */
import type { Store, UserSettingRecord } from '@/db/store';

export class SettingsError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

// ── Setting keys ─────────────────────────────────────────────────────────────
const KEY_LANGUAGE = 'preferred_language';
const KEY_VOICE = 'voice_profile';
const KEY_GEMINI_LIVE_KEY = 'voice_gemini_live_key';
const integrationKey = (id: string) => `integration:${id}`;

// ── Language ───────────────────────────────────────────────────────────────--
/** Languages selectable for AI conversation. BCP-47 primary subtags. */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'hi', label: 'Hindi' },
  { code: 'vi', label: 'Vietnamese' },
] as const;

export const DEFAULT_LANGUAGE = 'en';
const LANGUAGE_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

export async function getPreferredLanguage(store: Store, userId: string): Promise<string> {
  const rec = await store.getUserSetting(userId, KEY_LANGUAGE);
  const lang = rec?.value?.lang;
  return typeof lang === 'string' && LANGUAGE_CODES.has(lang as never) ? lang : DEFAULT_LANGUAGE;
}

export async function setPreferredLanguage(store: Store, userId: string, lang: string): Promise<string> {
  if (!LANGUAGE_CODES.has(lang as never)) {
    throw new SettingsError(`Unsupported language: ${lang}`);
  }
  await store.putUserSetting(userId, KEY_LANGUAGE, { lang });
  return lang;
}

// ── My Voice ─────────────────────────────────────────────────────────────────
export type VoiceProfileStatus = 'none' | 'pending';

export interface VoiceProfileView {
  /** Display label the user gives the cloned voice. */
  name: string | null;
  /** 'none' = not created; 'pending' = saved, synthesis activation pending. */
  status: VoiceProfileStatus;
  updatedAt: string | null;
}

const NO_VOICE: VoiceProfileView = { name: null, status: 'none', updatedAt: null };

export async function getVoiceProfile(store: Store, userId: string): Promise<VoiceProfileView> {
  const rec = await store.getUserSetting(userId, KEY_VOICE);
  if (!rec) return NO_VOICE;
  const name = typeof rec.value.name === 'string' ? rec.value.name : null;
  if (!name) return NO_VOICE;
  return { name, status: 'pending', updatedAt: rec.updatedAt };
}

export async function saveVoiceProfile(store: Store, userId: string, rawName: string): Promise<VoiceProfileView> {
  const name = rawName.trim();
  if (!name) throw new SettingsError('A name for your voice profile is required.');
  if (name.length > 80) throw new SettingsError('Voice profile name is too long (max 80 chars).');
  const rec = await store.putUserSetting(userId, KEY_VOICE, { name, status: 'pending' });
  return { name, status: 'pending', updatedAt: rec.updatedAt };
}

export async function deleteVoiceProfile(store: Store, userId: string): Promise<void> {
  await store.deleteUserSetting(userId, KEY_VOICE);
}

// ── Live-voice (Gemini) API key (SAU-259) ────────────────────────────────────
// Self-service provisioning of the Gemini Live key from Settings → My Voice, so
// the board can "check the setting" and drop in a key without touching env files.
// The raw key is read ONLY server-side (realtime token route); clients only ever
// see the masked view below. POC-grade — see file header.

/** Masked, client-safe view of the configured live-voice key (never the raw key). */
export interface GeminiLiveKeyView {
  configured: boolean;
  /** Last 4 chars for confirmation ("…last4"); null when not configured. */
  last4: string | null;
  updatedAt: string | null;
}

const NO_GEMINI_KEY: GeminiLiveKeyView = { configured: false, last4: null, updatedAt: null };

export async function getGeminiLiveKeyView(store: Store, userId: string): Promise<GeminiLiveKeyView> {
  const rec = await store.getUserSetting(userId, KEY_GEMINI_LIVE_KEY);
  const key = typeof rec?.value?.key === 'string' ? (rec!.value.key as string) : '';
  if (!key) return NO_GEMINI_KEY;
  return { configured: true, last4: key.slice(-4), updatedAt: rec!.updatedAt };
}

/**
 * The raw key for server-side use only (the realtime token route). Returns null
 * when the user hasn't configured one. NEVER return this to a client.
 */
export async function getGeminiLiveKeyRaw(store: Store, userId: string): Promise<string | null> {
  if (!userId) return null;
  const rec = await store.getUserSetting(userId, KEY_GEMINI_LIVE_KEY);
  const key = typeof rec?.value?.key === 'string' ? (rec.value.key as string).trim() : '';
  return key || null;
}

export async function saveGeminiLiveKey(store: Store, userId: string, rawKey: string): Promise<GeminiLiveKeyView> {
  const key = rawKey.trim();
  // Google API keys look like `AIza…` (~39 chars). Be forgiving on exact length
  // but reject obvious junk so we never store a non-key.
  if (key.length < 20) throw new SettingsError('That does not look like a valid Gemini API key.');
  if (key.length > 200) throw new SettingsError('Gemini API key is too long.');
  const rec = await store.putUserSetting(userId, KEY_GEMINI_LIVE_KEY, { key });
  return { configured: true, last4: key.slice(-4), updatedAt: rec.updatedAt };
}

export async function deleteGeminiLiveKey(store: Store, userId: string): Promise<void> {
  await store.deleteUserSetting(userId, KEY_GEMINI_LIVE_KEY);
}

// ── Integrations ───────────────────────────────────────────────────────────--
export type IntegrationId = 'phone' | 'calendar' | 'mcp';

interface IntegrationField {
  name: string;       // config key
  label: string;
  placeholder: string;
  /** Allowed values when the field is a choice (rendered as radios / checkboxes). */
  options?: { value: string; label: string }[];
  /** When true (with `options`), multiple values may be selected (checkboxes). */
  multi?: boolean;
}

interface IntegrationSpec {
  id: IntegrationId;
  title: string;
  description: string;
  fields: IntegrationField[];
}

/** Catalog of supported integrations (board ask: Phone, Calendar, MCP tools). */
export const INTEGRATIONS: IntegrationSpec[] = [
  {
    id: 'phone',
    title: 'Phone call',
    description: 'Route practice calls over your own telephony by adding a SIP trunk.',
    fields: [{ name: 'sipTrunkUri', label: 'SIP trunk URI', placeholder: 'sip:trunk@provider.example.com' }],
  },
  {
    id: 'calendar',
    title: 'Calendar connection',
    description: 'Connect a calendar so coaching sessions can be scheduled and reminders sent.',
    fields: [
      {
        name: 'provider',
        label: 'Calendar provider',
        placeholder: '',
        options: [
          { value: 'google', label: 'Google Calendar' },
          { value: 'outlook', label: 'Outlook / Microsoft 365' },
          { value: 'caldav', label: 'CalDAV' },
        ],
      },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP tools',
    description: 'Give scenarios access to external tools over the Model Context Protocol.',
    fields: [
      {
        name: 'tools',
        label: 'Enabled tools',
        placeholder: '',
        multi: true,
        options: [
          { value: 'gmail', label: 'Gmail' },
          { value: 'gcal', label: 'Google Calendar' },
        ],
      },
    ],
  },
];

const INTEGRATION_SPECS = new Map(INTEGRATIONS.map((s) => [s.id, s]));

export type IntegrationStatus = 'not_connected' | 'configured';

export interface IntegrationView {
  id: IntegrationId;
  title: string;
  description: string;
  fields: IntegrationField[];
  status: IntegrationStatus;
  /** Saved config values (echoed back to pre-fill the form). */
  config: Record<string, unknown>;
  updatedAt: string | null;
}

function toView(spec: IntegrationSpec, rec: UserSettingRecord | null): IntegrationView {
  const status = rec?.value?.status === 'configured' ? 'configured' : 'not_connected';
  const config = rec ? { ...rec.value } : {};
  delete (config as Record<string, unknown>).status;
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    fields: spec.fields,
    status,
    config,
    updatedAt: rec?.updatedAt ?? null,
  };
}

export async function listIntegrations(store: Store, userId: string): Promise<IntegrationView[]> {
  return Promise.all(
    INTEGRATIONS.map(async (spec) => toView(spec, await store.getUserSetting(userId, integrationKey(spec.id)))),
  );
}

/** Validate + persist an integration's connection config. */
export async function configureIntegration(
  store: Store,
  userId: string,
  id: string,
  rawConfig: Record<string, unknown>,
): Promise<IntegrationView> {
  const spec = INTEGRATION_SPECS.get(id as IntegrationId);
  if (!spec) throw new SettingsError(`Unknown integration: ${id}`, 404);

  const config: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const raw = rawConfig[field.name];
    if (field.options) {
      // Multi/single select against the allowed option values.
      const values = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
      const cleaned = values.filter((v) => field.options!.some((o) => o.value === v));
      if (cleaned.length === 0) throw new SettingsError(`Select at least one option for "${field.label}".`);
      config[field.name] = cleaned.length === 1 && !Array.isArray(raw) ? cleaned[0] : cleaned;
    } else {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) throw new SettingsError(`"${field.label}" is required.`);
      config[field.name] = value;
    }
  }

  const rec = await store.putUserSetting(userId, integrationKey(spec.id), { ...config, status: 'configured' });
  return toView(spec, rec);
}

export async function disconnectIntegration(store: Store, userId: string, id: string): Promise<IntegrationView> {
  const spec = INTEGRATION_SPECS.get(id as IntegrationId);
  if (!spec) throw new SettingsError(`Unknown integration: ${id}`, 404);
  await store.deleteUserSetting(userId, integrationKey(spec.id));
  return toView(spec, null);
}

// ── Account ────────────────────────────────────────────────────────────────--
export interface AccountInfo {
  displayName: string;
  email: string;
  /** How the user authenticates. Local password today; OAuth providers later. */
  loginMethod: string;
  memberSince: string;        // ISO
  planTier: string;           // free | standard | premium
  organizations: string[];    // none today (B2B deferred)
}

export async function getAccountInfo(store: Store, userId: string): Promise<AccountInfo | null> {
  const user = await store.getUserById(userId);
  if (!user) return null;
  const entitlement = await store.getEntitlement(userId);
  return {
    displayName: user.displayName,
    email: user.email,
    loginMethod: 'Email & password',
    memberSince: user.createdAt,
    planTier: entitlement?.planTier ?? 'free',
    organizations: [],
  };
}
