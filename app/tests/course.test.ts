import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { createScenarioFromMarkdown } from '@/services/scenarios';
import {
  createCourseFromMarkdown, resolveCourseScenarios, getCourseProgress, CourseCompileError,
} from '@/services/courses';
import { runVoiceSession } from '@/voice/session-service';

const S1 = `---\nid: objections\nname: Objection Handling\npersona: You are a skeptical buyer.\nvisibility: public\n---\n`;
const S2 = `---\nid: pushback\nname: Stakeholder Pushback\npersona: You disagree with the roadmap.\nvisibility: public\n---\n`;
const COURSE = `---\nid: sales-fundamentals\nname: Sales Fundamentals\nscenarios:\n  - objections\n  - pushback\nvisibility: public\n---\n`;

const USER = '00000000-0000-4000-8000-0000000000bb';

async function setup() {
  const store = new MemoryStore();
  await createScenarioFromMarkdown(store, S1);
  await createScenarioFromMarkdown(store, S2);
  const { course } = await createCourseFromMarkdown(store, COURSE);
  return { store, course };
}

test('a course compiles its ordered scenario refs (the Play All sequence)', async () => {
  const { store, course } = await setup();
  const ordered = await resolveCourseScenarios(store, course);
  assert.deepEqual(ordered.map((s) => s.slug), ['objections', 'pushback']);
});

test('course referencing an unknown scenario fails to compile (no dangling refs)', async () => {
  const store = new MemoryStore();
  await createScenarioFromMarkdown(store, S1);
  await assert.rejects(
    () => createCourseFromMarkdown(store, `---\nid: bad\nname: Bad\nscenarios: [objections, ghost]\n---\n`),
    /unknown scenario "ghost"/,
  );
});

test('starting an item runs a session and advances course progress', async () => {
  const { store, course } = await setup();

  const before = await getCourseProgress(store, course, USER);
  assert.equal(before.completed, 0);
  assert.equal(before.total, 2);
  assert.equal(before.fraction, 0);

  // "Start" the first item — a session tagged with this course.
  const ordered = await resolveCourseScenarios(store, course);
  await runVoiceSession({ store, scenario: ordered[0], vendor: 'mock', userId: USER, courseId: course.id });

  const after = await getCourseProgress(store, course, USER);
  assert.equal(after.completed, 1);
  assert.equal(after.items[0].completed, true);
  assert.equal(after.items[1].completed, false);
  assert.ok(after.fraction > 0 && after.fraction < 1);

  // Finish the course.
  await runVoiceSession({ store, scenario: ordered[1], vendor: 'mock', userId: USER, courseId: course.id });
  const done = await getCourseProgress(store, course, USER);
  assert.equal(done.completed, 2);
  assert.equal(done.fraction, 1);
});

test('progress is per-user (anonymous viewer sees zero)', async () => {
  const { store, course } = await setup();
  const ordered = await resolveCourseScenarios(store, course);
  await runVoiceSession({ store, scenario: ordered[0], vendor: 'mock', userId: USER, courseId: course.id });
  const anon = await getCourseProgress(store, course, null);
  assert.equal(anon.completed, 0);
});

test('createCourseFromMarkdown is idempotent (upsert, not duplicate)', async () => {
  const { store } = await setup();
  const again = await createCourseFromMarkdown(store, COURSE);
  assert.equal(again.created, false);
  assert.equal((await store.listCourses()).length, 1);
});
