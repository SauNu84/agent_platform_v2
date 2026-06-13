/**
 * Post-session intake extractor (SAU-267) — transcript → validated JSON intake.
 *
 * Turns a finished conversation into a structured, schema-validated patient intake
 * record (AC #4). Same swap-ability seam as the chat responder / voice vendors:
 *   - HeuristicIntakeExtractor (default): deterministic, dependency-free, no spend.
 *     It MERGES two signals — the structured `create_appointment` tool-call args
 *     (authoritative: the agent already collected name/doctor/reason/insurance/DOB
 *     to book) plus light keyword scans of the patient's turns for anything not
 *     captured in a tool call. This means a real, populated intake record even with
 *     the mock voice vendor — the booking loop is fully exercised offline.
 *   - LlmIntakeExtractor (key-gated, Claude): higher-fidelity free-text extraction.
 *
 * Output is always validated against `intakeSchema`; unparseable LLM output falls
 * back to the heuristic so finalization never fails.
 */
import { z } from 'zod';

export const intakeSchema = z.object({
  patientName: z.string().nullable().default(null),
  dob: z.string().nullable().default(null),
  reasonForVisit: z.string().nullable().default(null),
  insurance: z.string().nullable().default(null),
  preferredTimes: z.array(z.string()).default([]),
  phone: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});

export type IntakeRecord = z.infer<typeof intakeSchema>;

export interface IntakeTranscript {
  turns: Array<{ role: 'user' | 'agent'; text: string; at: number }>;
  toolCalls: Array<{ name: string; args: unknown; result: unknown; at: number }>;
}

export interface IntakeExtractor {
  readonly name: string;
  extract(t: IntakeTranscript): Promise<IntakeRecord>;
}

// ── Heuristic helpers ────────────────────────────────────────────────────────
function userText(t: IntakeTranscript): string {
  return t.turns.filter((x) => x.role === 'user').map((x) => x.text).join('\n');
}

/** Pull structured fields the agent already captured to BOOK (the strongest signal). */
function fromBookingArgs(t: IntakeTranscript): Partial<IntakeRecord> {
  const out: Partial<IntakeRecord> = {};
  for (const c of t.toolCalls) {
    if (c.name !== 'create_appointment' || !c.args || typeof c.args !== 'object') continue;
    const a = c.args as Record<string, unknown>;
    if (typeof a.patientName === 'string' && a.patientName.trim()) out.patientName = a.patientName.trim();
    if (typeof a.dob === 'string' && a.dob.trim()) out.dob = a.dob.trim();
    if (typeof a.reason === 'string' && a.reason.trim()) out.reasonForVisit = a.reason.trim();
    if (typeof a.insurance === 'string' && a.insurance.trim()) out.insurance = a.insurance.trim();
    if (typeof a.slotStart === 'string' && a.slotStart.trim()) out.preferredTimes = [a.slotStart.trim()];
  }
  return out;
}

const DOB_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i;
const PHONE_RE = /\b(\+?\d[\d\-().\s]{7,}\d)\b/;
const INSURERS = ['Aetna', 'Blue Cross', 'Blue Shield', 'Cigna', 'UnitedHealthcare', 'United Health', 'Medicare', 'Medicaid', 'Humana', 'Kaiser', 'Self-pay', 'self pay'];

function heuristicScan(text: string): Partial<IntakeRecord> {
  const out: Partial<IntakeRecord> = {};
  const dob = text.match(DOB_RE);
  if (dob) out.dob = dob[1];
  const phone = text.match(PHONE_RE);
  // Guard against matching dates / short numerics: a real phone has ≥10 digits
  // (an ISO DOB like 1990-03-04 has only 8), so we don't mistake a DOB for a phone.
  if (phone && (phone[1].replace(/\D/g, '').length >= 10)) out.phone = phone[1].trim();
  const ins = INSURERS.find((i) => text.toLowerCase().includes(i.toLowerCase()));
  if (ins) out.insurance = ins;
  // "my name is …" / "this is …"
  const name = text.match(/\b(?:my name is|this is|i'?m|i am)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})/);
  if (name) out.patientName = name[1].trim();
  return out;
}

function merge(...parts: Array<Partial<IntakeRecord>>): IntakeRecord {
  const acc: Partial<IntakeRecord> = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      if (v == null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if ((acc as Record<string, unknown>)[k] == null) (acc as Record<string, unknown>)[k] = v;
    }
  }
  return intakeSchema.parse(acc);
}

export class HeuristicIntakeExtractor implements IntakeExtractor {
  readonly name = 'heuristic';
  async extract(t: IntakeTranscript): Promise<IntakeRecord> {
    // Booking args win over loose text scans (more reliable).
    return merge(fromBookingArgs(t), heuristicScan(userText(t)));
  }
}

/**
 * Resolve the active extractor. Default = heuristic (deterministic, no spend).
 * A configured `ANTHROPIC_API_KEY` selects the live Claude extractor unless
 * `INTAKE_EXTRACTOR=heuristic` forces the offline path. Mirrors `getResponder`.
 */
export function getIntakeExtractor(): IntakeExtractor {
  const mode = (process.env.INTAKE_EXTRACTOR ?? 'auto').toLowerCase();
  if (mode !== 'heuristic' && process.env.ANTHROPIC_API_KEY) {
    const { LlmIntakeExtractor } = require('./adapters/anthropic') as typeof import('./adapters/anthropic');
    return new LlmIntakeExtractor();
  }
  return new HeuristicIntakeExtractor();
}

export async function extractIntake(t: IntakeTranscript): Promise<IntakeRecord> {
  return getIntakeExtractor().extract(t);
}
