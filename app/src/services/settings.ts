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
 * ONE group stores secrets: the Scenario AI Model API keys (OpenAI + Gemini,
 * SAU-259), so the board can self-provision keys from Settings → AI Model without
 * editing env files. Keys are validated against the provider on save. POC-grade:
 * the raw key is read ONLY server-side (the realtime token route, which mints an
 * ephemeral browser token — the key never reaches the client) and is NEVER echoed
 * back to any client (only a masked last-4 view). A provider's env var, when set,
 * takes precedence. Keys are encrypted at rest (AES-256-GCM, see lib/crypto.ts,
 * SAU-261) — no plaintext key survives a round-trip through the DB.
 */
import type { Store, UserSettingRecord } from '@/db/store';
import { encrypt, decryptIfEncrypted } from '@/lib/crypto';

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
const modelKeyKey = (p: ModelProvider) => `model_api_key:${p}`;
/** Legacy single-purpose Gemini key (first SAU-259 cut) — read-only fallback. */
const LEGACY_GEMINI_KEY = 'voice_gemini_live_key';
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

// ── Scenario AI Model API keys (SAU-259) ─────────────────────────────────────
// One self-service place (Settings → AI Model) to provision the provider keys the
// scenario engines need — OpenAI (Realtime voice + text chat) and Google Gemini
// (Gemini Live voice) — without editing env files. On save we VALIDATE the key
// against the provider so a bad key is rejected before it's stored.
//
// Raw keys are read ONLY server-side (the realtime token route); clients only ever
// see the masked last-4 view. POC-grade — see file header. The env var for a
// provider, when set, always takes precedence over a stored key.

export type ModelProvider = 'openai' | 'gemini';

interface ModelProviderSpec {
  id: ModelProvider;
  label: string;
  help: string;
  placeholder: string;
}

/** Providers offered in the AI Model settings tab. */
export const MODEL_PROVIDERS: ModelProviderSpec[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    help: 'Powers OpenAI Realtime voice (gpt-realtime / -mini) and text chat.',
    placeholder: 'sk-…',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    help: 'Powers live voice on Gemini 2.5 Flash Live.',
    placeholder: 'AIza…',
  },
];

const MODEL_PROVIDER_IDS = new Set(MODEL_PROVIDERS.map((p) => p.id));

/** Masked, client-safe view of a configured provider key (never the raw key). */
export interface ModelKeyView {
  provider: ModelProvider;
  label: string;
  help: string;
  placeholder: string;
  configured: boolean;
  /** Last 4 chars for confirmation ("…last4"); null when not configured. */
  last4: string | null;
  /** True when an env var supplies this key (takes precedence over a stored one). */
  envProvisioned: boolean;
  updatedAt: string | null;
}

export type KeyValidationStatus = 'valid' | 'invalid' | 'unreachable';
export interface KeyValidation {
  status: KeyValidationStatus;
  message?: string;
}

const ENV_FOR_PROVIDER: Record<ModelProvider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

function envKeyPresent(provider: ModelProvider): boolean {
  return Boolean(process.env[ENV_FOR_PROVIDER[provider]]);
}

/**
 * Live-validate a provider key with a cheap, read-only API call. Definitive
 * rejections (bad credentials) return `invalid`; transport problems return
 * `unreachable` (we still let the user save, with a warning). Bounded by an
 * 8s timeout so a hung provider never wedges the request.
 */
export async function validateModelApiKey(provider: ModelProvider, key: string): Promise<KeyValidation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (res.ok) return { status: 'valid' };
      if (res.status === 401 || res.status === 403) {
        return { status: 'invalid', message: 'OpenAI rejected this key (unauthorized).' };
      }
      return { status: 'unreachable', message: `OpenAI returned ${res.status}; couldn't confirm the key.` };
    }
    // gemini
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal: controller.signal },
    );
    if (res.ok) return { status: 'valid' };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { status: 'invalid', message: 'Google rejected this key (invalid or unauthorized).' };
    }
    return { status: 'unreachable', message: `Google returned ${res.status}; couldn't confirm the key.` };
  } catch {
    return { status: 'unreachable', message: "Couldn't reach the provider to validate the key." };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the raw provider key from a stored record, decrypting at rest (SAU-261).
 * Values written by {@link saveModelApiKey} are AES-256-GCM ciphertext; legacy /
 * not-yet-migrated rows may still be plaintext, which we pass through unchanged so
 * the read path stays back-compatible until migration 0014 runs.
 */
function readStoredKey(rec: UserSettingRecord | null): string {
  const raw = typeof rec?.value?.key === 'string' ? (rec.value.key as string) : '';
  return raw ? decryptIfEncrypted(raw) : '';
}

function toModelKeyView(spec: ModelProviderSpec, rec: UserSettingRecord | null): ModelKeyView {
  const key = readStoredKey(rec);
  return {
    provider: spec.id,
    label: spec.label,
    help: spec.help,
    placeholder: spec.placeholder,
    configured: Boolean(key),
    last4: key ? key.slice(-4) : null,
    envProvisioned: envKeyPresent(spec.id),
    updatedAt: rec?.updatedAt ?? null,
  };
}

export async function listModelApiKeys(store: Store, userId: string): Promise<ModelKeyView[]> {
  return Promise.all(
    MODEL_PROVIDERS.map(async (spec) => toModelKeyView(spec, await store.getUserSetting(userId, modelKeyKey(spec.id)))),
  );
}

/**
 * The raw key for a provider, for server-side use only (the realtime token route).
 * Falls back to the legacy Gemini key slot for back-compat. Returns null when the
 * user hasn't configured one. NEVER return this to a client.
 */
export async function getModelApiKeyRaw(
  store: Store,
  userId: string,
  provider: ModelProvider,
): Promise<string | null> {
  if (!userId) return null;
  let key = readStoredKey(await store.getUserSetting(userId, modelKeyKey(provider))).trim();
  if (!key && provider === 'gemini') {
    key = readStoredKey(await store.getUserSetting(userId, LEGACY_GEMINI_KEY)).trim();
  }
  return key || null;
}

/**
 * Validate then persist a provider key. A definitive provider rejection throws a
 * SettingsError (the key is NOT stored); a transport failure stores the key but
 * returns a `unreachable` validation so the UI can warn. Returns the masked view
 * plus the validation result.
 */
export async function saveModelApiKey(
  store: Store,
  userId: string,
  provider: string,
  rawKey: string,
  validate: (p: ModelProvider, k: string) => Promise<KeyValidation> = validateModelApiKey,
): Promise<{ view: ModelKeyView; validation: KeyValidation }> {
  if (!MODEL_PROVIDER_IDS.has(provider as ModelProvider)) {
    throw new SettingsError(`Unknown provider: ${provider}`, 404);
  }
  const spec = MODEL_PROVIDERS.find((p) => p.id === provider)!;
  const key = rawKey.trim();
  if (key.length < 20) throw new SettingsError(`That does not look like a valid ${spec.label} API key.`);
  if (key.length > 400) throw new SettingsError(`${spec.label} API key is too long.`);

  const validation = await validate(spec.id, key);
  if (validation.status === 'invalid') {
    throw new SettingsError(validation.message ?? `${spec.label} rejected this key.`, 400);
  }
  // Encrypt at rest (SAU-261): plaintext provider keys never touch the DB.
  const rec = await store.putUserSetting(userId, modelKeyKey(spec.id), { key: encrypt(key) });
  return { view: toModelKeyView(spec, rec), validation };
}

export async function deleteModelApiKey(store: Store, userId: string, provider: string): Promise<void> {
  if (!MODEL_PROVIDER_IDS.has(provider as ModelProvider)) {
    throw new SettingsError(`Unknown provider: ${provider}`, 404);
  }
  await store.deleteUserSetting(userId, modelKeyKey(provider as ModelProvider));
  // Also clear the legacy slot so a removed Gemini key doesn't resurrect.
  if (provider === 'gemini') await store.deleteUserSetting(userId, LEGACY_GEMINI_KEY);
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
