import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  getPreferredLanguage,
  setPreferredLanguage,
  getVoiceProfile,
  saveVoiceProfile,
  deleteVoiceProfile,
  listModelApiKeys,
  getModelApiKeyRaw,
  saveModelApiKey,
  deleteModelApiKey,
  listIntegrations,
  configureIntegration,
  disconnectIntegration,
  getPhoneIntegrationSetting,
  getAccountInfo,
  SettingsError,
} from '@/services/settings';
import { getTelephonyAdapter } from '@/services/telephony';
import { TwilioTelephonyAdapter } from '@/services/telephony/twilio-telephony';
import { MockTelephonyAdapter } from '@/services/telephony/mock-telephony';

const USER = 'user-1';
const OTHER = 'user-2';

/** Run `fn` with `vars` applied to process.env, restoring originals after. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const prior = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prior.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of prior) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TWILIO_ENV_KEYS = {
  TWILIO_ACCOUNT_SID: undefined,
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_PHONE_NUMBER: undefined,
  TELEPHONY_PUBLIC_URL: undefined,
  TELEPHONY_PROVIDER: undefined,
} as const;

const VALID_SID = 'AC0123456789abcdef0123456789abcdef';

// ── Language ─────────────────────────────────────────────────────────────────
test('AC: language defaults to English until the user sets one', async () => {
  const store = new MemoryStore();
  assert.equal(await getPreferredLanguage(store, USER), DEFAULT_LANGUAGE);
});

test('AC: a supported language persists and reads back', async () => {
  const store = new MemoryStore();
  await setPreferredLanguage(store, USER, 'vi');
  assert.equal(await getPreferredLanguage(store, USER), 'vi');
  // and it is own-scoped
  assert.equal(await getPreferredLanguage(store, OTHER), DEFAULT_LANGUAGE);
});

test('AC: an unsupported language is rejected', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => setPreferredLanguage(store, USER, 'xx'), SettingsError);
});

test('the language catalog includes the board-named option (Vietnamese)', () => {
  assert.ok(SUPPORTED_LANGUAGES.some((l) => l.code === 'vi'));
});

// ── My Voice ─────────────────────────────────────────────────────────────────
test('AC: a new account has no voice profile', async () => {
  const store = new MemoryStore();
  const v = await getVoiceProfile(store, USER);
  assert.equal(v.status, 'none');
  assert.equal(v.name, null);
});

test('AC: saving a voice profile stores the name and marks it pending activation', async () => {
  const store = new MemoryStore();
  const v = await saveVoiceProfile(store, USER, 'My speaking voice');
  assert.equal(v.status, 'pending');
  assert.equal(v.name, 'My speaking voice');
  assert.equal((await getVoiceProfile(store, USER)).status, 'pending');
});

test('AC: an empty voice name is rejected; a removed profile reverts to none', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => saveVoiceProfile(store, USER, '  '), SettingsError);
  await saveVoiceProfile(store, USER, 'Voice A');
  await deleteVoiceProfile(store, USER);
  assert.equal((await getVoiceProfile(store, USER)).status, 'none');
});

// ── Scenario AI Model API keys (SAU-259) ────────────────────────────────────────
const okValidator = async () => ({ status: 'valid' as const });
const GEMINI_KEY = 'AIzaSyExampleKey0123456789ABCDEF';
const OPENAI_KEY = 'sk-proj-ExampleKey0123456789ABCDEF';

test('AC: no model keys configured by default; raw reads are null', async () => {
  const store = new MemoryStore();
  const views = await listModelApiKeys(store, USER);
  assert.deepEqual(views.map((v) => v.provider).sort(), ['gemini', 'openai']);
  assert.ok(views.every((v) => v.configured === false && v.last4 === null));
  assert.equal(await getModelApiKeyRaw(store, USER, 'gemini'), null);
  assert.equal(await getModelApiKeyRaw(store, USER, 'openai'), null);
});

test('AC: saving a validated key stores it server-side, masked to last 4, own-scoped', async () => {
  const store = new MemoryStore();
  const { view, validation } = await saveModelApiKey(store, USER, 'gemini', `  ${GEMINI_KEY}  `, okValidator);
  assert.equal(view.configured, true);
  assert.equal(view.last4, GEMINI_KEY.slice(-4));
  assert.equal(validation.status, 'valid');
  assert.equal(await getModelApiKeyRaw(store, USER, 'gemini'), GEMINI_KEY); // trimmed, server-only
  assert.equal(await getModelApiKeyRaw(store, OTHER, 'gemini'), null);
  // both providers are independent slots
  await saveModelApiKey(store, USER, 'openai', OPENAI_KEY, okValidator);
  assert.equal(await getModelApiKeyRaw(store, USER, 'openai'), OPENAI_KEY);
});

test('AC: a provider-rejected key is NOT stored; an obviously-invalid key is rejected by format', async () => {
  const store = new MemoryStore();
  const rejectValidator = async () => ({ status: 'invalid' as const, message: 'bad key' });
  await assert.rejects(() => saveModelApiKey(store, USER, 'gemini', GEMINI_KEY, rejectValidator), SettingsError);
  assert.equal(await getModelApiKeyRaw(store, USER, 'gemini'), null); // not stored
  await assert.rejects(() => saveModelApiKey(store, USER, 'gemini', 'short', okValidator), SettingsError);
  await assert.rejects(() => saveModelApiKey(store, USER, 'bogus', GEMINI_KEY, okValidator), SettingsError);
});

test('a key that could not be validated (unreachable) is still saved, with a warning', async () => {
  const store = new MemoryStore();
  const unreachable = async () => ({ status: 'unreachable' as const, message: 'offline' });
  const { view, validation } = await saveModelApiKey(store, USER, 'openai', OPENAI_KEY, unreachable);
  assert.equal(view.configured, true);
  assert.equal(validation.status, 'unreachable');
  assert.equal(await getModelApiKeyRaw(store, USER, 'openai'), OPENAI_KEY);
});

test('removing a key clears it; gemini falls back to the legacy slot then is fully cleared', async () => {
  const store = new MemoryStore();
  // legacy single-purpose Gemini slot is still readable for back-compat
  await store.putUserSetting(USER, 'voice_gemini_live_key', { key: GEMINI_KEY });
  assert.equal(await getModelApiKeyRaw(store, USER, 'gemini'), GEMINI_KEY);
  await deleteModelApiKey(store, USER, 'gemini'); // clears both new + legacy slots
  assert.equal(await getModelApiKeyRaw(store, USER, 'gemini'), null);
});

test('getModelApiKeyRaw with an empty userId is null (never leaks across no-actor)', async () => {
  const store = new MemoryStore();
  assert.equal(await getModelApiKeyRaw(store, '', 'gemini'), null);
});

// ── Integrations ───────────────────────────────────────────────────────────--
test('AC: all three integrations start not connected', async () => {
  const store = new MemoryStore();
  const list = await listIntegrations(store, USER);
  assert.deepEqual(
    list.map((i) => i.id).sort(),
    ['calendar', 'mcp', 'phone'],
  );
  assert.ok(list.every((i) => i.status === 'not_connected'));
});

test('AC: configuring the phone integration validates + persists the SIP trunk', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => configureIntegration(store, USER, 'phone', {}), SettingsError);
  const iv = await configureIntegration(store, USER, 'phone', { sipTrunkUri: 'sip:trunk@example.com' });
  assert.equal(iv.status, 'configured');
  assert.equal(iv.config.sipTrunkUri, 'sip:trunk@example.com');
  // value persisted, not echoed with the internal status field
  assert.equal((iv.config as Record<string, unknown>).status, undefined);
});

// ── Phone: in-app Twilio config (SAU-381) ────────────────────────────────────
test('SAU-381: the phone card exposes the Twilio fields incl. a secret auth token', async () => {
  const store = new MemoryStore();
  const phone = (await listIntegrations(store, USER)).find((i) => i.id === 'phone')!;
  const names = phone.fields.map((f) => f.name);
  assert.deepEqual(
    names,
    ['sipTrunkUri', 'twilioAccountSid', 'twilioAuthToken', 'twilioPhoneNumber', 'bridgePublicUrl'],
  );
  const token = phone.fields.find((f) => f.name === 'twilioAuthToken')!;
  assert.equal(token.secret, true);
  assert.equal(token.optional, true);
  // No server-only `validate` fn leaks to the client view.
  assert.ok(!('validate' in token));
});

test('SAU-381: saving Twilio creds encrypts the token, masks on reload, never echoes plaintext', async () => {
  const store = new MemoryStore();
  const iv = await configureIntegration(store, USER, 'phone', {
    twilioAccountSid: VALID_SID,
    twilioAuthToken: 'super-secret-token-1234',
    twilioPhoneNumber: '+15551234567',
    bridgePublicUrl: 'wss://abc123.ngrok.io',
  });
  assert.equal(iv.status, 'configured');
  assert.equal(iv.config.twilioAccountSid, VALID_SID);
  // Masked hint only — never the raw token.
  assert.equal(iv.config.twilioAuthToken, '••••1234');
  assert.notEqual(iv.config.twilioAuthToken, 'super-secret-token-1234');

  // At rest the token is ciphertext, not plaintext.
  const rec = await store.getUserSetting(USER, 'integration:phone');
  const stored = (rec!.value as Record<string, unknown>).twilioAuthToken as string;
  assert.notEqual(stored, 'super-secret-token-1234');
  assert.match(stored, /:.+:/); // iv:ct:tag envelope shape

  // Reload masks too.
  const reloaded = (await listIntegrations(store, USER)).find((i) => i.id === 'phone')!;
  assert.equal(reloaded.config.twilioAuthToken, '••••1234');
});

test('SAU-381: re-saving with a blank auth token preserves the stored secret', async () => {
  const store = new MemoryStore();
  await configureIntegration(store, USER, 'phone', { twilioAccountSid: VALID_SID, twilioAuthToken: 'keep-me-please' });
  // Update only the phone number; leave the token blank (as the masked UI does).
  await configureIntegration(store, USER, 'phone', {
    twilioAccountSid: VALID_SID,
    twilioAuthToken: '',
    twilioPhoneNumber: '+15559998888',
  });
  await withEnv(TWILIO_ENV_KEYS, async () => {
    const setting = await getPhoneIntegrationSetting(store, USER);
    assert.equal(setting!.twilioAuthToken, 'keep-me-please');
    assert.equal(setting!.twilioPhoneNumber, '+15559998888');
  });

  // Re-submitting the masked echo also preserves it.
  await configureIntegration(store, USER, 'phone', { twilioAccountSid: VALID_SID, twilioAuthToken: '••••e-me' });
  await withEnv(TWILIO_ENV_KEYS, async () => {
    const setting = await getPhoneIntegrationSetting(store, USER);
    assert.equal(setting!.twilioAuthToken, 'keep-me-please');
  });
});

test('SAU-381: malformed Twilio creds are rejected before persistence', async () => {
  const store = new MemoryStore();
  await assert.rejects(
    () => configureIntegration(store, USER, 'phone', { twilioAccountSid: 'not-a-sid', twilioAuthToken: 'tok' }),
    SettingsError,
  );
  await assert.rejects(
    () => configureIntegration(store, USER, 'phone', { twilioPhoneNumber: '5551234567' }),
    SettingsError,
  );
  await assert.rejects(
    () => configureIntegration(store, USER, 'phone', { bridgePublicUrl: 'http://insecure.example' }),
    SettingsError,
  );
});

test('SAU-381 AC#2: saved SID+token select the live adapter when no env var is set; env overrides', async () => {
  const store = new MemoryStore();
  await configureIntegration(store, USER, 'phone', { twilioAccountSid: VALID_SID, twilioAuthToken: 'tok-abcd' });

  // No env creds ⇒ the saved setting selects the live Twilio adapter.
  await withEnv(TWILIO_ENV_KEYS, async () => {
    const setting = await getPhoneIntegrationSetting(store, USER);
    assert.equal(setting!.twilioAccountSid, VALID_SID);
    assert.equal(setting!.twilioAuthToken, 'tok-abcd'); // decrypted for server-side use
    assert.ok(getTelephonyAdapter(setting) instanceof TwilioTelephonyAdapter);

    // No setting at all ⇒ mock (fail-soft).
    assert.ok(getTelephonyAdapter(null) instanceof MockTelephonyAdapter);
  });

  // Env vars still take precedence over the saved setting.
  await withEnv({ ...TWILIO_ENV_KEYS, TWILIO_ACCOUNT_SID: 'ACenvenvenvenvenvenvenvenvenvenv01', TWILIO_AUTH_TOKEN: 'env-token' }, async () => {
    const setting = await getPhoneIntegrationSetting(store, USER);
    const adapter = getTelephonyAdapter(setting);
    assert.ok(adapter instanceof TwilioTelephonyAdapter);
    // The env SID wins over the saved one.
    const { getTwilioConfig } = await import('@/services/telephony');
    assert.equal(getTwilioConfig(setting)!.accountSid, 'ACenvenvenvenvenvenvenvenvenvenv01');
  });
});

test('AC: MCP tools accept the board-named tools and store them as a list', async () => {
  const store = new MemoryStore();
  const iv = await configureIntegration(store, USER, 'mcp', { tools: ['gmail', 'gcal'] });
  assert.deepEqual(iv.config.tools, ['gmail', 'gcal']);
  // unknown tools are filtered out
  await assert.rejects(() => configureIntegration(store, USER, 'mcp', { tools: ['nope'] }), SettingsError);
});

test('AC: an unknown integration id is a 404-class error; disconnect clears config', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => configureIntegration(store, USER, 'ghost', {}), (e) => {
    assert.ok(e instanceof SettingsError);
    assert.equal((e as SettingsError).status, 404);
    return true;
  });
  await configureIntegration(store, USER, 'calendar', { provider: 'google' });
  const iv = await disconnectIntegration(store, USER, 'calendar');
  assert.equal(iv.status, 'not_connected');
});

// ── Account ────────────────────────────────────────────────────────────────--
test('AC: account info aggregates identity + plan tier', async () => {
  const store = new MemoryStore();
  const user = await store.createUser({
    email: 'practitioner@demo.test',
    passwordHash: 'x',
    displayName: 'Practitioner Demo',
  });
  const info = await getAccountInfo(store, user.id);
  assert.ok(info);
  assert.equal(info!.email, 'practitioner@demo.test');
  assert.equal(info!.displayName, 'Practitioner Demo');
  assert.equal(info!.planTier, 'free'); // default when no entitlement row
  assert.deepEqual(info!.organizations, []);
});

test('account info is null for an unknown user', async () => {
  const store = new MemoryStore();
  assert.equal(await getAccountInfo(store, 'nobody'), null);
});
