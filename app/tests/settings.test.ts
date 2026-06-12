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
  listIntegrations,
  configureIntegration,
  disconnectIntegration,
  getAccountInfo,
  SettingsError,
} from '@/services/settings';

const USER = 'user-1';
const OTHER = 'user-2';

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
