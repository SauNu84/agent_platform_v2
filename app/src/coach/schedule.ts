/**
 * Coach schedule / recurrence (ADR-004 — coaches "can be scheduled").
 *
 * MVP scope: compute the next suggested session time from a coach's recurrence
 * rule, and render a human description for the UI. Times are evaluated in UTC for
 * deterministic behavior; per-user timezone localization is a tracked follow-up
 * (the `timezone` field is carried through so it can be honored later).
 */
import type { CoachSchedule } from '@/domain/coach';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseTime(time: string): { h: number; m: number } {
  const [h, m] = time.split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

function atUtc(base: Date, h: number, m: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m, 0, 0));
}

/**
 * Next occurrence at/after `fromMs`, or null for cadence 'none'. Deterministic:
 * pass `fromMs` rather than reading the clock.
 */
export function nextOccurrence(schedule: CoachSchedule, fromMs: number): Date | null {
  if (schedule.cadence === 'none') return null;
  const from = new Date(fromMs);
  const { h, m } = parseTime(schedule.time);
  const interval = Math.max(1, schedule.interval || 1);

  if (schedule.cadence === 'daily') {
    let candidate = atUtc(from, h, m);
    while (candidate.getTime() <= fromMs) {
      candidate = new Date(candidate.getTime() + interval * DAY_MS);
    }
    return candidate;
  }

  // weekly: scan the next 8 weeks for the first matching weekday + future time.
  const days = schedule.daysOfWeek.length ? schedule.daysOfWeek : [from.getUTCDay()];
  const daySet = new Set(days);
  for (let offset = 0; offset <= 7 * 8; offset++) {
    const day = new Date(from.getTime() + offset * DAY_MS);
    if (!daySet.has(day.getUTCDay())) continue;
    const candidate = atUtc(day, h, m);
    if (candidate.getTime() > fromMs) return candidate;
  }
  return null;
}

/** Human-readable schedule for the Coach detail UI. */
export function describeSchedule(schedule: CoachSchedule): string {
  if (schedule.cadence === 'none') return 'Not scheduled';
  const interval = Math.max(1, schedule.interval || 1);
  if (schedule.cadence === 'daily') {
    const every = interval === 1 ? 'Every day' : `Every ${interval} days`;
    return `${every} at ${schedule.time} ${schedule.timezone}`;
  }
  const days = (schedule.daysOfWeek.length ? schedule.daysOfWeek : [])
    .slice()
    .sort((a, b) => a - b)
    .map((d) => WEEKDAYS[d] ?? `?${d}`)
    .join(', ');
  const every = interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
  return `${every}${days ? ` on ${days}` : ''} at ${schedule.time} ${schedule.timezone}`;
}
