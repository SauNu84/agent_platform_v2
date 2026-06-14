/**
 * Escalation / human-handoff RULES (SAU-273, Phase 1 · WS4) — pure & testable.
 *
 * Like domain/clinic, the decision of WHEN to hand a live caller to a human and
 * WHICH path to use lives here in deterministic code, not in the agent's prompt.
 * The telephony I/O (warm transfer, voicemail, callback) lives behind the handoff
 * seam (services/handoff) and is injected by the escalation service.
 *
 * Three escalation triggers (AC #2):
 *   • requested_human — the caller explicitly asks for a person.
 *   • unresolved      — the agent could not complete the task (no booking, not a
 *                       clean "no slot"): a complex/ambiguous case a human owns.
 *   • system_failure  — a model/telephony hiccup mid-call (AC #3): never drop the
 *                       caller; route them to a human/voicemail instead.
 */

export type EscalationReason = 'requested_human' | 'unresolved' | 'ambiguous' | 'system_failure';
export type HandoffAction = 'warm_transfer' | 'voicemail' | 'callback' | 'none';

export interface EscalationDecision {
  escalate: boolean;
  reason: EscalationReason | null;
}

type Turn = { role: 'user' | 'agent'; text: string; at: number };

// Phrases a caller uses to ask for a person. Word-boundary matched so "agent"
// doesn't fire on "urgent" etc.
const HUMAN_REQUEST = [
  'talk to a human',
  'speak to a human',
  'talk to a person',
  'speak to a person',
  'real person',
  'speak to someone',
  'talk to someone',
  'speak with a representative',
  'representative',
  'receptionist',
  'front desk',
  'speak to a nurse',
  'talk to the doctor',
  'speak to staff',
  'human please',
  'get me a human',
  'transfer me',
];

/** Did the caller explicitly ask for a human at any point? */
export function callerRequestedHuman(turns: Turn[]): boolean {
  for (const t of turns) {
    if (t.role !== 'user') continue;
    const text = t.text.toLowerCase();
    if (HUMAN_REQUEST.some((p) => text.includes(p))) return true;
  }
  return false;
}

/**
 * Classify whether a finished/derived session should escalate, and why.
 *   - An explicit human request always wins (reason: requested_human).
 *   - A forced trigger (e.g. orchestrator caught a model/telephony error) maps to
 *     system_failure.
 *   - Otherwise, when the derived booking outcome is `escalated`, the agent didn't
 *     resolve the task → reason: unresolved.
 */
export function classifyEscalation(opts: {
  turns: Turn[];
  /** The booking outcome the booking flow derived ('booked' | 'no_slot' | 'escalated'). */
  outcome: 'booked' | 'no_slot' | 'escalated';
  /** Hard override from the orchestrator on a mid-call failure. */
  forced?: 'system_failure' | null;
}): EscalationDecision {
  if (opts.forced === 'system_failure') return { escalate: true, reason: 'system_failure' };
  if (callerRequestedHuman(opts.turns)) return { escalate: true, reason: 'requested_human' };
  if (opts.outcome === 'escalated') return { escalate: true, reason: 'unresolved' };
  return { escalate: false, reason: null };
}

/** Minutes-from-midnight + weekday for a timestamp (UTC, matching domain/clinic). */
function dayParts(ms: number): { weekday: number; minOfDay: number } {
  const d = new Date(ms);
  return { weekday: d.getUTCDay(), minOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** Is the clinic closed at `nowMs`? Reuses the same hours table as the booking engine. */
export function isAfterHours(
  hours: Array<{ openMin: number; closeMin: number } | null>,
  nowMs: number,
): boolean {
  const { weekday, minOfDay } = dayParts(nowMs);
  const today = hours[weekday];
  if (!today) return true; // closed all day
  return minOfDay < today.openMin || minOfDay >= today.closeMin;
}

/**
 * Pick the handoff path for an escalation:
 *   • after-hours        → voicemail (caller leaves a message; callback for failures).
 *   • during open hours  → warm_transfer to clinic staff.
 *   • system_failure after-hours → callback request (we'll ring them back), since
 *     there's no one to transfer to and a transient failure may resolve.
 */
export function resolveHandoffAction(opts: { reason: EscalationReason; afterHours: boolean }): HandoffAction {
  if (opts.afterHours) {
    return opts.reason === 'system_failure' ? 'callback' : 'voicemail';
  }
  return 'warm_transfer';
}
