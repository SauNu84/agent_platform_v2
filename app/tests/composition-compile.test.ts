import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCoachContent, renderCoachToMarkdown, CoachCompileError } from '@/compiler/coach-compile';
import { compileCourseContent, renderCourseToMarkdown, CourseCompileError } from '@/compiler/course-compile';

const COACH_MD = `---
id: pitch-coach
name: Pitch Coach
scenario_ref: sales-objection-handling
retention: persistent
schedule:
  cadence: weekly
  daysOfWeek: [1, 3]
  time: "09:00"
  timezone: UTC
---
`;

const COURSE_MD = `---
id: sales-fundamentals
name: Sales Fundamentals
description: Core selling skills.
scenarios:
  - sales-objection-handling
  - pm-stakeholder-pushback
coach_ref: pitch-coach
visibility: public
---
`;

test('compiles a coach .md into the canonical record', () => {
  const { record } = compileCoachContent(COACH_MD);
  assert.equal(record.slug, 'pitch-coach');
  assert.equal(record.scenarioRef, 'sales-objection-handling');
  assert.equal(record.retention, 'persistent');
  assert.equal(record.schedule.cadence, 'weekly');
  assert.deepEqual(record.schedule.daysOfWeek, [1, 3]);
});

test('coach round-trip: compile(render(compile(md))) is stable', () => {
  const first = compileCoachContent(COACH_MD).record;
  const second = compileCoachContent(renderCoachToMarkdown(first)).record;
  assert.deepEqual(second, first);
});

test('coach requires a scenario_ref', () => {
  const bad = `---\nid: x\nname: No Scenario\n---\n`;
  assert.throws(() => compileCoachContent(bad), CoachCompileError);
});

test('compiles a course .md with ordered scenario refs', () => {
  const { record } = compileCourseContent(COURSE_MD);
  assert.equal(record.slug, 'sales-fundamentals');
  assert.deepEqual(record.scenarioRefs, ['sales-objection-handling', 'pm-stakeholder-pushback']);
  assert.equal(record.coachRef, 'pitch-coach');
  assert.equal(record.isPublic, true);
});

test('course round-trip is stable', () => {
  const first = compileCourseContent(COURSE_MD).record;
  const second = compileCourseContent(renderCourseToMarkdown(first)).record;
  assert.deepEqual(second, first);
});

test('course requires at least one scenario and rejects duplicates', () => {
  assert.throws(() => compileCourseContent(`---\nid: empty\nname: Empty\nscenarios: []\n---\n`), CourseCompileError);
  assert.throws(
    () => compileCourseContent(`---\nid: dup\nname: Dup\nscenarios: [a, a]\n---\n`),
    CourseCompileError,
  );
});
