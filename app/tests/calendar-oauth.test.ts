/**
 * SAU-271 — Phase 1 · WS2: real Google Calendar integration (OAuth, per-clinic).
 *
 * Covers the WS2 acceptance criteria without hitting Google:
 *  - OAuth tokens stored ENCRYPTED at rest; read path recovers them (SAU-261).
 *  - The actor-aware adapter resolver picks the connected calendar, the env
 *    sandbox token, or FAILS SOFT to the mock — no credentials ⇒ no crash.
 *  - check_availability reads real free/busy and create_appointment writes a real
 *    event (returns the vendor event id) through the GoogleCalendarAdapter, and the
 *    clinic RULES (no double-book) still hold against the real-adapter shape.
 *  - OAuth plumbing: consent URL, code exchange, refresh, and the self-verifying
 *    CSRF state are correct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { isEncrypted } from '@/lib/crypto';
import { GoogleCalendarAdapter } from '@/services/calendar/google-calendar';
import { MockCalendarAdapter, resolveCalendarAdapter } from '@/services/calendar';
import { createAppointment, checkAvailability } from '@/services/clinic-booking';
import {
  CALENDAR_OAUTH_KEY,
  saveGoogleConnection,
  readGoogleConnection,
  clearGoogleConnection,
  ensureFreshAccessToken,
  getCalendarConnectionView,
  buildOAuthState,
  verifyOAuthState,
} from '@/services/calendar/calendar-connection';
import {
  readGoogleOAuthConfig,
  buildConsentUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  GOOGLE_CALENDAR_SCOPE,
  type GoogleTokenResponse,
} from '@/services/calendar/google-oauth';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FAR_FUTURE = Date.parse('2099-01-01T00:00:00Z');

/** A deterministic open clinic weekday at 09:00Z (mirrors clinic-booking.test). */
function openDay9amZ(): number {
  // Mon–Fri are open in DEFAULT_CLINIC; 2026-06-15 is a Monday.
  let ms = Date.parse('2026-06-15T09:00:00Z');
  while ([0, 6].includes(new Date(ms).getUTCDay())) ms += DAY;
  return ms;
}

function tokens(overrides: Partial<GoogleTokenResponse> = {}): GoogleTokenResponse {
  return {
    accessToken: 'ya29.access-token',
    refreshToken: 'refresh-token-xyz',
    expiryMs: FAR_FUTURE,
    scope: GOOGLE_CALENDAR_SCOPE,
    ...overrides,
  };
}

/** Run `fn` with env vars set, restoring prior values afterward. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Replace globalThis.fetch with `stub` for the duration of `fn`. */
async function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** A stand-in Google Calendar v3 backend kept in-memory (events POST + list GET). */
function googleCalendarStub(): typeof fetch {
  const events: Array<{ id: string; htmlLink: string; start: unknown; end: unknown; description: string }> = [];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' && u.includes('/events')) {
      const body = JSON.parse(String(init.body)) as { start: unknown; end: unknown; description?: string };
      const id = `g-evt-${events.length + 1}`;
      const evt = { id, htmlLink: `https://calendar.google.com/event?eid=${id}`, start: body.start, end: body.end, description: body.description ?? '' };
      events.push(evt);
      return new Response(JSON.stringify(evt), { status: 200 });
    }
    if (u.includes('/events')) {
      return new Response(JSON.stringify({ items: events }), { status: 200 });
    }
    throw new Error(`unexpected fetch in stub: ${u}`);
  }) as typeof fetch;
}

// ── Encryption at rest (AC: tokens stored encrypted) ──────────────────────────-
test('AC: OAuth tokens are stored ENCRYPTED at rest and read back', async () => {
  const store = new MemoryStore();
  await saveGoogleConnection(store, 'user-1', tokens(), 'primary');

  // The raw stored record must NOT contain the plaintext tokens.
  const rec = await store.getUserSetting('user-1', CALENDAR_OAUTH_KEY);
  assert.ok(rec, 'connection record exists');
  assert.equal(typeof rec!.value.enc, 'string');
  assert.equal(isEncrypted(rec!.value.enc), true, 'token blob is ciphertext');
  const serialized = JSON.stringify(rec!.value);
  assert.ok(!serialized.includes('refresh-token-xyz'), 'refresh token never stored in plaintext');
  assert.ok(!serialized.includes('ya29.access-token'), 'access token never stored in plaintext');

  // The read path decrypts and recovers the tokens.
  const conn = await readGoogleConnection(store, 'user-1');
  assert.ok(conn);
  assert.equal(conn!.tokens.accessToken, 'ya29.access-token');
  assert.equal(conn!.tokens.refreshToken, 'refresh-token-xyz');
  assert.equal(conn!.calendarId, 'primary');

  // Disconnect removes it; it's own-scoped.
  await clearGoogleConnection(store, 'user-1');
  assert.equal(await readGoogleConnection(store, 'user-1'), null);
});

test('connection view is own-scoped and reports oauthConfigured from env', async () => {
  const store = new MemoryStore();
  await saveGoogleConnection(store, 'user-1', tokens(), 'clinic-cal');
  await withEnv({ GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'sec' }, async () => {
    const mine = await getCalendarConnectionView(store, 'user-1');
    assert.equal(mine.connected, true);
    assert.equal(mine.calendarId, 'clinic-cal');
    assert.equal(mine.oauthConfigured, true);
    const other = await getCalendarConnectionView(store, 'user-2');
    assert.equal(other.connected, false);
  });
  await withEnv({ GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: undefined }, async () => {
    const v = await getCalendarConnectionView(store, 'user-1');
    assert.equal(v.oauthConfigured, false);
  });
});

// ── Adapter resolution (AC: no creds ⇒ fail soft; connection ⇒ real) ───────────
test('AC: no credentials and no connection ⇒ resolver fails soft to the mock', async () => {
  const store = new MemoryStore();
  await withEnv({ CALENDAR_PROVIDER: undefined, GOOGLE_CALENDAR_ACCESS_TOKEN: undefined }, async () => {
    const adapter = await resolveCalendarAdapter({ store, userId: 'nobody' });
    assert.equal(adapter.simulated, true);
    assert.ok(adapter instanceof MockCalendarAdapter);
  });
});

test('CALENDAR_PROVIDER=mock forces the mock even with a connection', async () => {
  const store = new MemoryStore();
  await saveGoogleConnection(store, 'user-1', tokens(), 'primary');
  await withEnv({ CALENDAR_PROVIDER: 'mock' }, async () => {
    const adapter = await resolveCalendarAdapter({ store, userId: 'user-1' });
    assert.equal(adapter.simulated, true);
  });
});

test('AC: a stored OAuth connection resolves to the real Google adapter', async () => {
  const store = new MemoryStore();
  await saveGoogleConnection(store, 'user-1', tokens({ expiryMs: FAR_FUTURE }), 'primary');
  await withEnv({ CALENDAR_PROVIDER: undefined, GOOGLE_CALENDAR_ACCESS_TOKEN: undefined }, async () => {
    const adapter = await resolveCalendarAdapter({ store, userId: 'user-1' });
    assert.equal(adapter.simulated, false);
    assert.match(adapter.label, /connected/);
  });
});

// ── Real-adapter booking + double-book (AC #1 + AC #3) ────────────────────────-
test('AC: check_availability + create_appointment work through the Google adapter, and double-book is refused', async () => {
  await withFetch(googleCalendarStub(), async () => {
    const calendar = new GoogleCalendarAdapter({ accessToken: 'ya29.x', calendarId: 'primary', source: 'oauth' });
    const now = openDay9amZ();
    const deps = { calendar, nowMs: now };

    // Reads real free/busy (none yet) and offers slots.
    const avail = await checkAvailability({ doctor: 'dr-chen' }, deps);
    assert.equal(avail.simulated, false);
    assert.ok(avail.slots.length > 0);
    const slot = avail.slots[0];

    // Writes a real event and returns the vendor event id (proof of booking).
    const booked = await createAppointment(
      { patientName: 'Jordan Patel', doctor: 'dr-chen', slotStart: slot.start, reason: 'cough', insurance: 'Aetna' },
      deps,
    );
    assert.equal(booked.booked, true);
    if (booked.booked) {
      assert.equal(booked.eventId, 'g-evt-1');
      assert.ok(booked.htmlLink?.startsWith('https://calendar.google.com/'));
      assert.equal(booked.simulated, false);
    }

    // Same slot again → the tool re-reads real busy state and refuses (rules in the tool).
    const again = await createAppointment(
      { patientName: 'Sam Lee', doctor: 'dr-chen', slotStart: slot.start, reason: 'checkup' },
      deps,
    );
    assert.equal(again.booked, false);
    if (!again.booked) assert.equal(again.reason, 'double_book');
  });
});

// ── OAuth plumbing ────────────────────────────────────────────────────────────
test('readGoogleOAuthConfig + buildConsentUrl produce a correct consent URL', async () => {
  await withEnv({ GOOGLE_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'shh' }, () => {
    const cfg = readGoogleOAuthConfig();
    assert.ok(cfg);
    const url = new URL(buildConsentUrl(cfg!, { redirectUri: 'https://app.example/api/integrations/google-calendar/callback', state: 'st-1' }));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), GOOGLE_CALENDAR_SCOPE);
    assert.equal(url.searchParams.get('state'), 'st-1');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/api/integrations/google-calendar/callback');
  });
});

test('readGoogleOAuthConfig returns null when unconfigured (fail-soft gate)', async () => {
  await withEnv({ GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: undefined }, () => {
    assert.equal(readGoogleOAuthConfig(), null);
  });
});

test('exchangeCodeForTokens parses the token response', async () => {
  const stub: typeof fetch = (async (url: string | URL | Request) => {
    assert.match(String(url), /oauth2\.googleapis\.com\/token/);
    return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPE }), { status: 200 });
  }) as typeof fetch;
  await withFetch(stub, async () => {
    const t = await exchangeCodeForTokens({ clientId: 'c', clientSecret: 's' }, 'auth-code', 'https://app/cb', 1_000_000);
    assert.equal(t.accessToken, 'at-1');
    assert.equal(t.refreshToken, 'rt-1');
    assert.equal(t.expiryMs, 1_000_000 + 3600 * 1000);
  });
});

test('refreshAccessToken carries the existing refresh token forward', async () => {
  const stub: typeof fetch = (async () =>
    new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200 })) as typeof fetch;
  await withFetch(stub, async () => {
    const t = await refreshAccessToken({ clientId: 'c', clientSecret: 's' }, 'rt-keep', 2_000_000);
    assert.equal(t.accessToken, 'at-new');
    assert.equal(t.refreshToken, 'rt-keep', 'refresh token preserved across refresh');
  });
});

test('ensureFreshAccessToken refreshes an expired token and persists the new one', async () => {
  const store = new MemoryStore();
  const now = 5_000_000;
  // Stored token already expired (expiryMs < now).
  await saveGoogleConnection(store, 'user-1', tokens({ accessToken: 'at-old', expiryMs: now - HOUR }), 'primary');
  const conn = await readGoogleConnection(store, 'user-1');
  assert.ok(conn);

  const stub: typeof fetch = (async () =>
    new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }), { status: 200 })) as typeof fetch;
  await withEnv({ GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' }, async () => {
    await withFetch(stub, async () => {
      const at = await ensureFreshAccessToken(store, 'user-1', conn!, now);
      assert.equal(at, 'at-fresh');
    });
  });
  // Persisted: a subsequent read returns the refreshed token with a future expiry.
  const after = await readGoogleConnection(store, 'user-1');
  assert.equal(after!.tokens.accessToken, 'at-fresh');
  assert.ok(after!.tokens.expiryMs > now);
});

test('ensureFreshAccessToken returns the stored token when still fresh (no network)', async () => {
  const store = new MemoryStore();
  await saveGoogleConnection(store, 'user-1', tokens({ accessToken: 'at-fresh', expiryMs: FAR_FUTURE }), 'primary');
  const conn = await readGoogleConnection(store, 'user-1');
  const failFetch: typeof fetch = (async () => {
    throw new Error('should not be called when token is fresh');
  }) as typeof fetch;
  await withFetch(failFetch, async () => {
    assert.equal(await ensureFreshAccessToken(store, 'user-1', conn!, Date.now()), 'at-fresh');
  });
});

// ── CSRF state ────────────────────────────────────────────────────────────────
test('OAuth state binds the flow to the user and recovers the calendar id', () => {
  const state = buildOAuthState('user-1', 'clinic-cal');
  assert.deepEqual(verifyOAuthState(state, 'user-1'), { calendarId: 'clinic-cal', returnTo: null });
  // Wrong user ⇒ rejected (CSRF / mix-up protection).
  assert.equal(verifyOAuthState(state, 'user-2'), null);
  // Garbage ⇒ rejected, no throw.
  assert.equal(verifyOAuthState('not-a-state', 'user-1'), null);
});
