/**
 * Text chat with a scenario persona — the generation seam (SAU-224).
 *
 * The scenario detail page offers a **text Chat** with the scenario persona (the
 * board replaced the live/simulated voice demo on that surface). Generation is
 * behind a `ChatResponder` seam — the SAME swap-ability pattern as the realtime
 * voice vendors (ADR-003), the authoring `Author`, and the Analyst `Scorer`.
 *
 * The default `MockChatResponder` is deterministic and dependency-free, so the
 * whole chat path (turn → persist as a `session` → Sessions/History/Analytics) is
 * testable offline with no spend and FAILS SOFT when no key is configured — exactly
 * mirroring the Join mock. The production `AnthropicChatResponder` (Claude,
 * `claude-opus-4-8`) implements the identical interface and is selected when a key
 * is configured (see `getResponder`).
 */

/** One conversation turn. `agent` is the scenario persona; `user` is the learner. */
export interface ChatTurn {
  role: 'user' | 'agent';
  text: string;
}

export interface ChatReplyInput {
  /** The persona system prompt (built from the scenario's aiInstructions). */
  system: string;
  /** The conversation so far (excludes the new user message). */
  history: ChatTurn[];
  /** The new user message to respond to, in character. */
  message: string;
}

/** The chat generation seam. A production LLM responder implements this interface. */
export interface ChatResponder {
  readonly name: string; // 'mock' | 'anthropic:<model>'
  reply(input: ChatReplyInput): Promise<string>;
}

/** Build the persona system prompt for a chat from a scenario's instructions. */
export function chatSystemPrompt(personaInstructions: string): string {
  return [
    'You are role-playing a character in a text practice conversation with a learner.',
    'Stay fully in character at all times and never break the fourth wall.',
    'Respond to what the learner actually says: be specific, raise plausible',
    'objections, and keep replies conversational (a few sentences) — do not lecture.',
    '',
    '--- YOUR CHARACTER / INSTRUCTIONS ---',
    personaInstructions.trim(),
  ].join('\n');
}

function shorten(s: string, n = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Deterministic, dependency-free responder (default; testable, no spend, no key).
 * It stays loosely "in character" by echoing the first line of the persona prompt
 * and acknowledging the learner's message, so the end-to-end chat path (persist →
 * Sessions/History/Analytics) is fully exercised offline. Real conversational
 * quality comes from `AnthropicChatResponder` once a key is present.
 */
export class MockChatResponder implements ChatResponder {
  readonly name = 'mock';

  async reply(input: ChatReplyInput): Promise<string> {
    const personaLine =
      input.system
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('---') && !l.startsWith('You are role') && !l.startsWith('Stay fully') && !l.startsWith('Respond to') && !l.startsWith('objections')) ??
      'your practice counterpart';
    const turn = input.history.filter((t) => t.role === 'user').length + 1;
    return (
      `(simulated) ${shorten(personaLine)} ` +
      `You said: "${shorten(input.message)}". Tell me more — what's your next move? [turn ${turn}]`
    );
  }
}

/**
 * Resolve the active chat responder. Default = deterministic mock (tested, no
 * spend) so the page works with no key. A configured `ANTHROPIC_API_KEY` selects
 * the live Claude responder; `CHAT_PROVIDER=mock` forces the mock even with a key.
 * Mirrors `getAuthor` (authoring), `getProvider` (voice), and `getScorer` (analyst).
 */
export function getResponder(): ChatResponder {
  const provider = (process.env.CHAT_PROVIDER ?? 'anthropic').toLowerCase();
  if (provider !== 'mock' && process.env.ANTHROPIC_API_KEY) {
    // Lazy require keeps the live adapter out of the default/test path entirely.
    const { AnthropicChatResponder } = require('./adapters/anthropic') as typeof import('./adapters/anthropic');
    return new AnthropicChatResponder();
  }
  return new MockChatResponder();
}
