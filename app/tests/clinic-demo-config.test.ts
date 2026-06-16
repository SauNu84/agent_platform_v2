/**
 * SAU-297 — AI Clinic Agent demo config panel: connect a Google Calendar + set the
 * phone numbers from /use-cases/clinic-agent, so a call books into THAT calendar.
 *
 * Covers, without hitting Google:
 *  - Phone config: E.164 validation, per-user persistence, default trial number,
 *    clear-to-default, and the PhoneIntegrationSetting mapping for the bridge.
 *  - Calendar binding: switching the target calendar in place (no re-consent) makes
 *    resolveCalendarAdapter point the booking tools at the chosen calendar.
 *  - OAuth `state` carries a vetted same-origin returnTo (so consent can come back
 *    to the demo panel) and rejects open-redirect attempts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { GOOGLE_CALENDAR_SCOPE, type GoogleTokenResponse } from '@/services/calendar/google-oauth';
import { GoogleCalendarAdapter } from '@/services/calendar/google-calendar';
import { resolveCalendarAdapter } from '@/services/calendar';
import {
  saveGoogleConnection,
  setConnectionCalendarId,
  readGoogleConnection,
  getCalendarConnectionView,
  buildOAuthState,
  verifyOAuthState,
  safeReturnTo,
} from '@/services/calendar/calendar-connection';
import { toUseCaseLinks } from '@/services/use-cases';
import {
  DEFAULT_AGENT_NUMBER,
  getClinicPhoneConfig,
  getClinicPhoneView,
  saveClinicPhoneConfig,
  clearClinicPhoneConfig,
  resolveAgentNumber,
  toPhoneIntegrationSetting,
  ClinicPhoneError,
} from '@/services/clinic-phone';
import {
  GOOGLE_OAUTH_APP_KEY,
  saveGoogleOAuthApp,
  clearGoogleOAuthApp,
  readStoredGoogleOAuthConfig,
  resolveGoogleOAuthConfig,
  getGoogleOAuthAppView,
  GoogleOAuthAppError,
} from '@/services/calendar/google-oauth-config';
import { isEncrypted } from '@/lib/crypto';

const FAR_FUTURE = Date.parse('2099-01-01T00:00:00Z');
const USER = 'user-clinic-1';

function tokens(overrides: Partial<GoogleTokenResponse> = {}): GoogleTokenResponse {
  return {
    accessToken: 'ya29.access-token',
    refreshToken: 'refresh-token-xyz',
    expiryMs: FAR_FUTURE,
    scope: GOOGLE_CALENDAR_SCOPE,
    ...overrides,
  };
}

// ── Phone config ─────────────────────────────────────────────────────────────
test('phone view defaults to the trial number and is unconfigured initially', async () => {
  const store = new MemoryStore();
  const view = await getClinicPhoneView(store, USER);
  assert.equal(view.configured, false);
  assert.equal(view.agentNumber, null);
  assert.equal(view.defaultAgentNumber, DEFAULT_AGENT_NUMBER);
  // With no saved config and no env, the effective number is the default.
  assert.equal(await resolveAgentNumber(store, USER), DEFAULT_AGENT_NUMBER);
});

test('saveClinicPhoneConfig persists numbers per-user and round-trips', async () => {
  const store = new MemoryStore();
  const view = await saveClinicPhoneConfig(store, USER, {
    agentNumber: '+14155550123',
    clinicHandoffNumber: '+14155559999',
  });
  assert.equal(view.configured, true);
  assert.equal(view.agentNumber, '+14155550123');
  assert.equal(view.clinicHandoffNumber, '+14155559999');

  const cfg = await getClinicPhoneConfig(store, USER);
  assert.equal(cfg?.agentNumber, '+14155550123');
  assert.equal(await resolveAgentNumber(store, USER), '+14155550123');

  // Another user is isolated (own-scoped key).
  assert.equal(await getClinicPhoneConfig(store, 'other-user'), null);
});

test('phone config normalizes spacing/punctuation and rejects non-E.164', async () => {
  const store = new MemoryStore();
  const view = await saveClinicPhoneConfig(store, USER, { agentNumber: '+1 (415) 555-0123' });
  assert.equal(view.agentNumber, '+14155550123');
  assert.equal(view.clinicHandoffNumber, null);

  await assert.rejects(() => saveClinicPhoneConfig(store, USER, { agentNumber: '4155550123' }), ClinicPhoneError);
  await assert.rejects(() => saveClinicPhoneConfig(store, USER, { agentNumber: '' }), ClinicPhoneError);
  await assert.rejects(
    () => saveClinicPhoneConfig(store, USER, { agentNumber: '+14155550123', clinicHandoffNumber: 'nope' }),
    ClinicPhoneError,
  );
});

test('clearClinicPhoneConfig reverts to default and maps to a bridge setting', async () => {
  const store = new MemoryStore();
  await saveClinicPhoneConfig(store, USER, { agentNumber: '+14155550123' });
  const setting = await toPhoneIntegrationSetting(store, USER);
  assert.equal(setting?.twilioPhoneNumber, '+14155550123');

  const view = await clearClinicPhoneConfig(store, USER);
  assert.equal(view.configured, false);
  assert.equal(await toPhoneIntegrationSetting(store, USER), null);
});

// ── Calendar binding ───────────────────────────────────────────────────────--
test('setConnectionCalendarId points the booking adapter at the chosen calendar', async () => {
  const store = new MemoryStore();
  // No connection yet → can't set a target calendar.
  assert.equal(await setConnectionCalendarId(store, USER, 'clinic@group.calendar.google.com'), false);

  await saveGoogleConnection(store, USER, tokens(), 'primary');
  const ok = await setConnectionCalendarId(store, USER, 'clinic@group.calendar.google.com');
  assert.equal(ok, true);

  const conn = await readGoogleConnection(store, USER);
  assert.equal(conn?.calendarId, 'clinic@group.calendar.google.com');
  // tokens are preserved through the in-place switch (no re-consent needed).
  assert.equal(conn?.tokens.refreshToken, 'refresh-token-xyz');

  const adapter = await resolveCalendarAdapter({ store, userId: USER });
  assert.ok(adapter instanceof GoogleCalendarAdapter, 'connected ⇒ real Google adapter');
  assert.match(adapter.label, /clinic@group\.calendar\.google\.com/, 'label names the target calendar');
  assert.equal(adapter.simulated, false);
});

// ── OAuth state returnTo ─────────────────────────────────────────────────────
test('OAuth state round-trips a vetted same-origin returnTo', () => {
  const state = buildOAuthState(USER, 'primary', '/use-cases/clinic-agent/configure');
  const v = verifyOAuthState(state, USER);
  assert.equal(v?.returnTo, '/use-cases/clinic-agent/configure');
  assert.equal(v?.calendarId, 'primary');
  // Bound to the user — a different actor can't complete the flow.
  assert.equal(verifyOAuthState(state, 'attacker'), null);
});

test('safeReturnTo blocks open-redirects; bad returnTo is dropped from state', () => {
  assert.equal(safeReturnTo('/ok/path'), '/ok/path');
  assert.equal(safeReturnTo('//evil.example.com'), null);
  assert.equal(safeReturnTo('https://evil.example.com'), null);
  assert.equal(safeReturnTo('javascript:alert(1)'), null);

  const state = buildOAuthState(USER, 'primary', 'https://evil.example.com');
  assert.equal(verifyOAuthState(state, USER)?.returnTo, null);
});

// ── Google OAuth app credentials (no .env) ───────────────────────────────────
const ORIGIN = 'https://demo.example.com';
const CLIENT_ID = '1234-abc.apps.googleusercontent.com';

test('OAuth app creds: client secret is encrypted at rest and never echoed', async () => {
  const store = new MemoryStore();
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  const view = await saveGoogleOAuthApp(store, USER, ORIGIN, CLIENT_ID, 'GOCSPX-secret-value');
  assert.equal(view.configured, true);
  assert.equal(view.secretConfigured, true);
  assert.equal(view.envProvisioned, false);
  assert.equal(view.clientIdMasked, `…${CLIENT_ID.slice(-8)}`, 'client id is masked to its tail');
  assert.equal(view.redirectUri, `${ORIGIN}/api/integrations/google-calendar/callback`);
  // The view never carries the raw secret.
  assert.equal((view as Record<string, unknown>).clientSecret, undefined);

  // The stored secret is ciphertext, not plaintext.
  const rec = await store.getUserSetting(USER, GOOGLE_OAUTH_APP_KEY);
  assert.ok(isEncrypted(String(rec?.value.clientSecret)), 'secret stored encrypted');
  assert.equal(rec?.value.clientId, CLIENT_ID, 'client id stored plaintext (not a secret)');

  // The server-only resolver recovers the decrypted config.
  const cfg = await readStoredGoogleOAuthConfig(store, USER);
  assert.equal(cfg?.clientId, CLIENT_ID);
  assert.equal(cfg?.clientSecret, 'GOCSPX-secret-value');
});

test('OAuth app creds: env takes precedence over stored, and clear reverts', async () => {
  const store = new MemoryStore();
  await saveGoogleOAuthApp(store, USER, ORIGIN, CLIENT_ID, 'GOCSPX-stored');

  // No env → resolves to stored.
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  assert.equal((await resolveGoogleOAuthConfig(store, USER))?.clientSecret, 'GOCSPX-stored');

  // Env present → env wins.
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'env-id.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'GOCSPX-env';
  const envCfg = await resolveGoogleOAuthConfig(store, USER);
  assert.equal(envCfg?.clientSecret, 'GOCSPX-env');
  assert.equal((await getGoogleOAuthAppView(store, USER, ORIGIN)).envProvisioned, true);
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  // Clear removes the stored creds → not configured.
  const cleared = await clearGoogleOAuthApp(store, USER, ORIGIN);
  assert.equal(cleared.configured, false);
  assert.equal(await resolveGoogleOAuthConfig(store, USER), null);
});

test('OAuth app creds: rejects an implausible client id / short secret', async () => {
  const store = new MemoryStore();
  await assert.rejects(() => saveGoogleOAuthApp(store, USER, ORIGIN, 'not-a-client-id', 'GOCSPX-long-enough'), GoogleOAuthAppError);
  await assert.rejects(() => saveGoogleOAuthApp(store, USER, ORIGIN, CLIENT_ID, 'short'), GoogleOAuthAppError);
  await assert.rejects(() => saveGoogleOAuthApp(store, USER, ORIGIN, '', 'GOCSPX-long-enough'), GoogleOAuthAppError);
});

test('storing OAuth app creds flips the calendar connection view to configured', async () => {
  const store = new MemoryStore();
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  const before = await getCalendarConnectionView(store, USER);
  assert.equal(before.oauthConfigured, false, 'no creds ⇒ connect gated');

  await saveGoogleOAuthApp(store, USER, ORIGIN, CLIENT_ID, 'GOCSPX-secret-value');
  const after = await getCalendarConnectionView(store, USER);
  assert.equal(after.oauthConfigured, true, 'stored creds ⇒ connect enabled (no .env)');
});

// ── Nav sub-link ─────────────────────────────────────────────────────────────
test('clinic-agent carries a "Set up a demo" nav sub-link', () => {
  const clinic = toUseCaseLinks().find((u) => u.slug === 'clinic-agent');
  assert.ok(clinic, 'clinic-agent link exists');
  const sub = clinic!.subLinks?.find((s) => s.href === '/use-cases/clinic-agent/configure');
  assert.ok(sub, 'has the configure sub-link');
  assert.equal(sub!.label, 'Set up a demo');
});
