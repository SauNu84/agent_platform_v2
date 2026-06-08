import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import { compileScenarioContent } from '@/compiler/compile';
import { compileCourseContent, validateCourseReferences, CourseCompileError } from '@/compiler/course-compile';
import { toCompiledScenario } from '@/domain/scenario';
import {
  Author, AuthoringBrief, AuthorOptions, GeneratedCourse, TemplateAuthor,
} from '@/authoring/author';
import {
  generateScenarioDraft, generateCourseDraft, publishScenarioDraft, publishCourseDraft, AuthoringError,
} from '@/authoring/pipeline';
import { getScenario } from '@/services/scenarios';

/** A scripted author for exercising failure/repair paths deterministically. */
class ScriptedAuthor implements Author {
  readonly name = 'scripted';
  sCalls = 0;
  cCalls = 0;
  constructor(private scenarios: string[], private courses: GeneratedCourse[] = []) {}
  async generateScenario(_brief: AuthoringBrief, _opts?: AuthorOptions): Promise<string> {
    return this.scenarios[Math.min(this.sCalls++, this.scenarios.length - 1)];
  }
  async generateCourse(_brief: AuthoringBrief, _opts?: AuthorOptions): Promise<GeneratedCourse> {
    return this.courses[Math.min(this.cCalls++, this.courses.length - 1)];
  }
}

const BRIEF: AuthoringBrief = { topic: 'handling a skeptical enterprise security buyer', role: 'Sales', difficulty: 'advanced' };

test('AC1: template author emits a scenario that passes the Slice-1 compiler and is a working scenario', async () => {
  const store = new MemoryStore();
  const draft = await generateScenarioDraft(BRIEF, { author: new TemplateAuthor() });

  assert.equal(draft.ok, true, draft.errors);
  assert.equal(draft.kind, 'scenario');
  // The draft is NOT persisted yet — generation never writes the DB.
  assert.equal((await store.listScenarios()).length, 0);

  // The MD independently passes the same compiler the platform uses.
  const { record } = compileScenarioContent(draft.md);
  assert.equal(record.slug, draft.slug);
  assert.equal(record.rubric.length, 3);

  // Publish through the review gate → a real, playable scenario row.
  const scenario = await publishScenarioDraft(store, draft, { approvedBy: 'coach@acme' });
  assert.ok(scenario.id);
  assert.equal(await getScenario(store, scenario.slug).then((s) => s?.slug), scenario.slug);
  const compiled = toCompiledScenario(scenario); // the voice seam's view → "working scenario"
  assert.ok(compiled.aiInstructions.length > 0);
  assert.equal(scenario.rubric.length, 3);
  // content_source recorded for drift detection.
  assert.ok(await store.getContentSource('scenario', scenario.id));
});

test('AC1: template author emits a course that compiles and produces working member scenarios', async () => {
  const store = new MemoryStore();
  const draft = await generateCourseDraft({ ...BRIEF, scenarioCount: 3 }, { author: new TemplateAuthor() });

  assert.equal(draft.ok, true, draft.errors);
  assert.equal(draft.course?.scenarioRefs.length, 3);
  assert.equal(draft.scenarios.length, 3);
  // Course manifest compiles and every reference resolves to a generated member.
  const { record } = compileCourseContent(draft.courseMd);
  validateCourseReferences(record, draft.scenarios.map((m) => m.slug!));

  const { course, scenarios } = await publishCourseDraft(store, draft, { approvedBy: 'coach@acme' });
  assert.equal(scenarios.length, 3);
  assert.deepEqual(course.scenarioRefs, scenarios.map((s) => s.slug));
  // Each member is a real, retrievable scenario.
  for (const s of scenarios) {
    assert.equal(await getScenario(store, s.slug).then((x) => x?.id), s.id);
  }
});

test('AC2: an invalid generation is rejected with actionable errors and never publishes', async () => {
  const store = new MemoryStore();
  const invalidMd = `---\nname: Missing Id And Persona\n---\n`; // no id, no persona
  const draft = await generateScenarioDraft(BRIEF, { author: new ScriptedAuthor([invalidMd]), maxAttempts: 1 });

  assert.equal(draft.ok, false);
  assert.match(draft.errors!, /id/);       // actionable: names the missing field
  assert.match(draft.errors!, /persona/);

  // Publishing a failed draft is refused — nothing reaches the store.
  await assert.rejects(() => publishScenarioDraft(store, draft, { approvedBy: 'coach@acme' }), AuthoringError);
  assert.equal((await store.listScenarios()).length, 0);
});

test('AC2: the review gate requires an explicit approver', async () => {
  const store = new MemoryStore();
  const draft = await generateScenarioDraft(BRIEF, { author: new TemplateAuthor() });
  assert.equal(draft.ok, true);
  // No approver → refused (review gate), even though the draft is valid.
  await assert.rejects(() => publishScenarioDraft(store, draft, { approvedBy: '   ' }), AuthoringError);
  assert.equal((await store.listScenarios()).length, 0);
});

test('AC2: publish re-validates the bytes — a tampered "ok" draft with bad MD is still rejected', async () => {
  const store = new MemoryStore();
  const tampered = { kind: 'scenario' as const, ok: true, md: `---\nname: no id\n---\n`, slug: 'x', attempts: 1, author: 'x' };
  await assert.rejects(() => publishScenarioDraft(store, tampered, { approvedBy: 'coach@acme' }));
  assert.equal((await store.listScenarios()).length, 0);
});

test('repair loop: an author that first emits invalid then valid MD recovers within the attempt budget', async () => {
  const invalidMd = `---\nname: Bad\n---\n`;
  const validMd = await new TemplateAuthor().generateScenario(BRIEF);
  const author = new ScriptedAuthor([invalidMd, validMd]);
  const draft = await generateScenarioDraft(BRIEF, { author, maxAttempts: 2 });

  assert.equal(draft.ok, true, draft.errors);
  assert.equal(draft.attempts, 2);     // it took the repair turn
  assert.equal(author.sCalls, 2);
});

test('course gate: a course referencing a non-existent scenario is rejected with an actionable error', async () => {
  // Members compile fine, but the manifest points at a slug that was never generated.
  const member = await new TemplateAuthor().generateScenario({ topic: 'discovery calls' });
  const memberSlug = compileScenarioContent(member).record.slug;
  const courseMd = `---\nid: broken-course\nname: Broken Course\nscenarios:\n  - ${memberSlug}\n  - ghost-scenario\nvisibility: private\n---\n`;
  const author = new ScriptedAuthor([], [{ courseMd, scenarioMds: [member] }]);

  const draft = await generateCourseDraft({ topic: 'broken' }, { author, maxAttempts: 1 });
  assert.equal(draft.ok, false);
  assert.match(draft.errors!, /ghost-scenario/);
});

test('course compiler rejects duplicate ordered members', () => {
  const md = `---\nid: dup-course\nname: Dup\nscenarios:\n  - a-scenario\n  - a-scenario\n---\n`;
  assert.throws(() => compileCourseContent(md), CourseCompileError);
});
