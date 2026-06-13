/**
 * Calendar adapter factory (SAU-267). Resolves the live Google adapter when
 * sandbox credentials are configured, else FAILS SOFT to the deterministic mock —
 * so a key-less environment runs the full booking loop against a simulated
 * calendar with zero credentials and never crashes (AC #3).
 */
import type { Store } from '@/db/store';
import type { CalendarAdapter } from './calendar-adapter';
import { MockCalendarAdapter } from './mock-calendar';
import { GoogleCalendarAdapter, readGoogleCalendarConfig } from './google-calendar';
import { readGoogleConnection, ensureFreshAccessToken } from './calendar-connection';

export type { CalendarAdapter, CalendarEvent, CalendarEventInput } from './calendar-adapter';
export { MockCalendarAdapter, __resetMockCalendar } from './mock-calendar';

/**
 * Synchronous resolver (Phase 0). `GOOGLE_CALENDAR_ACCESS_TOKEN` (+ optional
 * `GOOGLE_CALENDAR_ID`) selects the real sandbox Google adapter; otherwise the
 * simulated mock. `CALENDAR_PROVIDER=mock` forces the mock even with a token.
 * Used by non-actor contexts and as the fail-soft fallback of the async resolver.
 */
export function getCalendarAdapter(): CalendarAdapter {
  const provider = (process.env.CALENDAR_PROVIDER ?? 'auto').toLowerCase();
  if (provider !== 'mock') {
    const cfg = readGoogleCalendarConfig();
    if (cfg) return new GoogleCalendarAdapter(cfg);
  }
  return new MockCalendarAdapter();
}

/**
 * Actor-aware resolver (SAU-271, Phase 1 · WS2). Resolution order:
 *   1. `CALENDAR_PROVIDER=mock` ⇒ always the simulated mock.
 *   2. The user's per-clinic Google OAuth connection (encrypted tokens; refreshed
 *      on demand) ⇒ the real connected calendar.
 *   3. The Phase-0 env sandbox token, if present.
 *   4. FAIL SOFT to the deterministic mock — no credentials ⇒ no crash (AC #2).
 *
 * Any error reading/refreshing the OAuth connection degrades to (3)/(4) rather
 * than throwing, so a key problem never takes down a live booking.
 */
export async function resolveCalendarAdapter(opts?: {
  store?: Store;
  userId?: string | null;
}): Promise<CalendarAdapter> {
  const provider = (process.env.CALENDAR_PROVIDER ?? 'auto').toLowerCase();
  if (provider === 'mock') return new MockCalendarAdapter();

  if (opts?.store && opts.userId) {
    try {
      const conn = await readGoogleConnection(opts.store, opts.userId);
      if (conn) {
        const accessToken = await ensureFreshAccessToken(opts.store, opts.userId, conn);
        return new GoogleCalendarAdapter({ accessToken, calendarId: conn.calendarId, source: 'oauth' });
      }
    } catch (e) {
      console.warn('[calendar] OAuth connection unavailable, falling back:', (e as Error).message);
    }
  }

  const cfg = readGoogleCalendarConfig();
  if (cfg) return new GoogleCalendarAdapter(cfg);
  return new MockCalendarAdapter();
}
