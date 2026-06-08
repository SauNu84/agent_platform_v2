import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, describeSchedule } from '@/coach/schedule';
import { coachScheduleSchema } from '@/domain/coach';

function sched(partial: Record<string, unknown>) {
  return coachScheduleSchema.parse(partial);
}

test('cadence none has no next occurrence', () => {
  assert.equal(nextOccurrence(sched({ cadence: 'none' }), Date.UTC(2026, 5, 8, 8, 0)), null);
});

test('daily: later today if the time has not passed, else next interval', () => {
  const from = Date.UTC(2026, 5, 8, 8, 0); // 08:00 UTC
  const todayLater = nextOccurrence(sched({ cadence: 'daily', time: '09:00' }), from)!;
  assert.equal(todayLater.getTime(), Date.UTC(2026, 5, 8, 9, 0));

  const tomorrow = nextOccurrence(sched({ cadence: 'daily', time: '07:00' }), from)!;
  assert.equal(tomorrow.getTime(), Date.UTC(2026, 5, 9, 7, 0));

  const every3 = nextOccurrence(sched({ cadence: 'daily', interval: 3, time: '07:00' }), from)!;
  assert.equal(every3.getTime(), Date.UTC(2026, 5, 11, 7, 0));
});

test('weekly: returns a future occurrence on one of the configured weekdays', () => {
  const from = Date.UTC(2026, 5, 8, 8, 0); // Monday
  const next = nextOccurrence(sched({ cadence: 'weekly', daysOfWeek: [3], time: '09:00' }), from)!;
  assert.equal(next.getUTCDay(), 3); // Wednesday
  assert.ok(next.getTime() > from);
});

test('describeSchedule renders human-readable cadence', () => {
  assert.equal(describeSchedule(sched({ cadence: 'none' })), 'Not scheduled');
  assert.match(describeSchedule(sched({ cadence: 'daily', time: '09:00' })), /Every day at 09:00/);
  assert.match(describeSchedule(sched({ cadence: 'weekly', daysOfWeek: [1, 3], time: '09:00' })), /Weekly on Mon, Wed/);
});
