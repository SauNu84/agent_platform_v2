/**
 * Calendar adapter factory (SAU-267). Resolves the live Google adapter when
 * sandbox credentials are configured, else FAILS SOFT to the deterministic mock —
 * so a key-less environment runs the full booking loop against a simulated
 * calendar with zero credentials and never crashes (AC #3).
 */
import type { CalendarAdapter } from './calendar-adapter';
import { MockCalendarAdapter } from './mock-calendar';
import { GoogleCalendarAdapter, readGoogleCalendarConfig } from './google-calendar';

export type { CalendarAdapter, CalendarEvent, CalendarEventInput } from './calendar-adapter';
export { MockCalendarAdapter, __resetMockCalendar } from './mock-calendar';

/**
 * Resolve the active calendar adapter. `GOOGLE_CALENDAR_ACCESS_TOKEN` (+ optional
 * `GOOGLE_CALENDAR_ID`) selects the real sandbox Google adapter; otherwise the
 * simulated mock. `CALENDAR_PROVIDER=mock` forces the mock even with a token.
 */
export function getCalendarAdapter(): CalendarAdapter {
  const provider = (process.env.CALENDAR_PROVIDER ?? 'auto').toLowerCase();
  if (provider !== 'mock') {
    const cfg = readGoogleCalendarConfig();
    if (cfg) return new GoogleCalendarAdapter(cfg);
  }
  return new MockCalendarAdapter();
}
