/**
 * Claude intake extractor (LIVE) — higher-fidelity transcript → JSON intake.
 * Key-gated behind `IntakeExtractor`; mirrors the chat Anthropic adapter (raw
 * HTTPS to the Messages API, no SDK). Falls back to the heuristic extractor on any
 * error or unparseable output so post-session finalization never fails (AC #4).
 */
import { intakeSchema, HeuristicIntakeExtractor, type IntakeExtractor, type IntakeRecord, type IntakeTranscript } from '../extractor';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.INTAKE_MODEL || 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM = [
  'You extract a structured patient intake record from a clinic phone-call transcript.',
  'Return ONLY a JSON object with these keys (use null / [] when unknown — never invent data):',
  '{ "patientName": string|null, "dob": string|null, "reasonForVisit": string|null,',
  '  "insurance": string|null, "preferredTimes": string[], "phone": string|null, "notes": string|null }',
  'These are SYNTHETIC test patients (no real PHI). Output JSON only, no prose.',
].join('\n');

export class LlmIntakeExtractor implements IntakeExtractor {
  readonly name = `anthropic:${MODEL}`;

  async extract(t: IntakeTranscript): Promise<IntakeRecord> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return new HeuristicIntakeExtractor().extract(t);

    const transcriptText = t.turns.map((x) => `${x.role === 'agent' ? 'Agent' : 'Patient'}: ${x.text}`).join('\n');
    const booking = t.toolCalls.filter((c) => c.name === 'create_appointment').map((c) => JSON.stringify(c.args));
    const content = `Transcript:\n${transcriptText}\n\nBooking tool calls (authoritative where present):\n${booking.join('\n') || '(none)'}`;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, messages: [{ role: 'user', content }] }),
      });
      if (!res.ok) return new HeuristicIntakeExtractor().extract(t);
      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      const raw = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
      const json = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const parsed = intakeSchema.safeParse(JSON.parse(json));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to heuristic */
    }
    return new HeuristicIntakeExtractor().extract(t);
  }
}
