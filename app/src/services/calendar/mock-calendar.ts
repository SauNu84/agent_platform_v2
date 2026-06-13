/**
 * MockCalendarAdapter (SAU-267) — the fail-soft, dependency-free calendar.
 *
 * Used whenever no real calendar credentials are configured (the Phase-0 default).
 * Events live in a process-lifetime module store keyed by doctor so that an
 * appointment created mid-conversation immediately shows as BUSY to the next
 * `check_availability` / double-book guard within the same demo — the booking loop
 * is genuinely exercised, just against an in-memory sandbox instead of Google.
 *
 * Event ids are real, unique, and returned as proof of completion — they are just
 * clearly labeled `sim-…` so nobody mistakes a simulated booking for a Google one.
 */
import type { CalendarAdapter, CalendarEvent, CalendarEventInput } from './calendar-adapter';

// Process-lifetime store. Reset between server restarts; that's fine for a spike.
const store: CalendarEvent[] = [];
let seq = 0;

/** Stable-ish unique id without Math.random (deterministic within a process). */
function nextId(): string {
  seq += 1;
  return `sim-evt-${seq.toString(36)}-${(store.length + 1).toString(36)}`;
}

export class MockCalendarAdapter implements CalendarAdapter {
  readonly label = 'Simulated calendar (sandbox)';
  readonly simulated = true;

  async listBusy(range: { fromMs: number; toMs: number }, doctorId?: string) {
    return store
      .filter((e) => (!doctorId || e.doctorId === doctorId) && e.startMs < range.toMs && range.fromMs < e.endMs)
      .map((e) => ({ doctorId: e.doctorId, startMs: e.startMs, endMs: e.endMs }));
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const evt: CalendarEvent = {
      id: nextId(),
      doctorId: input.doctorId,
      summary: input.summary,
      startMs: input.startMs,
      endMs: input.endMs,
      htmlLink: undefined,
    };
    store.push(evt);
    return evt;
  }
}

/** Test/seed helper: clear the in-memory calendar. */
export function __resetMockCalendar(): void {
  store.length = 0;
  seq = 0;
}
