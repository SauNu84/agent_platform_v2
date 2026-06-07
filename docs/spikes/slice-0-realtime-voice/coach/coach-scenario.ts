/**
 * The Coach scenario — Slice-0 MVP foundation (SAU-194).
 *
 * This is the ONE persona the foundation ships with: a brief reflective coach.
 * It is a plain `CompiledScenario` (the same vendor-neutral shape the bench uses),
 * so the agent foundation never sees an OpenAI type. Extend the foundation by
 * editing `aiInstructions`, adding entries to `tools`, and registering a matching
 * handler in `coach/run.ts` (or wherever you embed `VoiceAgent`).
 *
 * Two tools are defined to prove tool-calling end-to-end AND to give the next
 * person a concrete pattern for the two sides of the Coach memory model (ADR-004):
 *   - `saveReflection` — a write tool (sideEffect 'server'): the coach persists a
 *      key insight the user surfaced. Backed by the minimal `CoachMemory` stub.
 *   - `recallReflections` — a read tool: the coach pulls back recent reflections so
 *      a session can reference earlier ones. (Full memory model is a later slice.)
 *
 * Only `saveReflection` is required to satisfy the acceptance ("at least one tool
 * call"); `recallReflections` is included because a read+write pair is the smallest
 * shape that reads like a real coach and exercises the stub both ways.
 */
import type { CompiledScenario } from '../realtime-interface.ts';

export const COACH_SYSTEM_PROMPT = [
  'You are Coach — a warm, concise reflective coach.',
  'Speak in short, natural spoken sentences (one or two at a time); never lecture.',
  'Ask one open question at a time and listen. Reflect back what you hear.',
  'When the user names a concrete insight, goal, or commitment, CALL `saveReflection`',
  'to remember it — keep talking naturally while it saves.',
  'At the start of a session, or when the user asks what they said before, CALL',
  '`recallReflections` and weave the most relevant one back in.',
  'Never give medical, legal, or financial advice; coach the person, not the problem.',
].join(' ');

export const COACH_SCENARIO: CompiledScenario = {
  id: 'slice0-coach',
  name: 'Coach (Slice-0 MVP)',
  aiInstructions: COACH_SYSTEM_PROMPT,
  // 'alloy' is the OpenAI default; the adapter reads OPENAI_VOICE and ignores this
  // name for OpenAI. Kept so the scenario is self-describing and vendor-portable.
  voice: { name: 'alloy', languageCode: 'en-US' },
  tools: [
    {
      name: 'saveReflection',
      description:
        'Persist a concise insight, goal, or commitment the user surfaced this session ' +
        'so the coach can reference it later. Call this the moment a real insight lands.',
      paramsSchema: {
        type: 'object',
        properties: {
          insight: { type: 'string', description: 'The reflection to remember, in the user\'s own framing.' },
          tag: { type: 'string', description: 'Optional one-word theme, e.g. "career", "habits".' },
        },
        required: ['insight'],
      },
      sideEffect: 'server',
    },
    {
      name: 'recallReflections',
      description:
        'Retrieve the most recent reflections saved for this user so the coach can ' +
        'reference earlier sessions. Call at session start or when the user asks.',
      paramsSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent reflections to fetch (default 3).' },
        },
      },
      sideEffect: 'server',
    },
  ],
};
