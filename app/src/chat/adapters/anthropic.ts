/**
 * Anthropic (Claude) chat adapter (LIVE) — one file = one provider behind the
 * `ChatResponder` seam, mirroring the authoring adapter and the realtime voice
 * adapters.
 *
 * Transport: raw HTTPS to the Messages API (the repo's vendor convention — see
 * authoring/adapters/anthropic.ts and voice/adapters/openai.ts — keeps the
 * dependency surface minimal; no SDK). Auth: `ANTHROPIC_API_KEY`. Model:
 * `claude-opus-4-8` (the most capable Claude; override via `CHAT_MODEL`).
 *
 * The persona system prompt comes from the scenario's instructions; the
 * conversation history is mapped to alternating user/assistant turns so Claude
 * continues the role-play in character.
 */
import { ChatResponder, ChatReplyInput } from '../responder';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.CHAT_MODEL || 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicChatResponder implements ChatResponder {
  readonly name = `anthropic:${MODEL}`;

  async reply(input: ChatReplyInput): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY not set — live chat is BLOCKED on credential provisioning. ' +
        'The default MockChatResponder runs the chat path offline with no spend.',
      );
    }
    // Map our turns to the Messages API roles (agent → assistant), then append
    // the new learner message as the final user turn.
    const messages = [
      ...input.history.map((t) => ({
        role: t.role === 'agent' ? 'assistant' : 'user',
        content: t.text,
      })),
      { role: 'user', content: input.message },
    ];

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: input.system,
        messages,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic Messages API ${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
      .trim();
    if (!text) throw new Error('Anthropic Messages API returned no text content');
    return text;
  }
}
