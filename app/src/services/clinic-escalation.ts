/**
 * Clinic escalation / human-handoff orchestration (SAU-273, Phase 1 · WS4).
 *
 * Decides — via the pure domain/escalation rules — whether a live call should go
 * to a human and which path to use (warm transfer during open hours, voicemail or
 * callback after hours), executes it through the fail-soft handoff seam, and
 * notifies the clinic. The result feeds the session's `escalated` outcome so the
 * handoff is recorded, queryable, and verifiable (AC #2/#3).
 *
 * Mid-call graceful fallback (AC #3): `gracefulFallback` is the entry point the
 * orchestrator calls when a model/telephony hiccup occurs — it forces a
 * system_failure escalation so a transient error routes the caller to a person /
 * voicemail instead of dropping them.
 */
import { DEFAULT_CLINIC, type ClinicConfig } from '@/domain/clinic';
import {
  classifyEscalation,
  isAfterHours,
  resolveHandoffAction,
  type EscalationReason,
  type HandoffAction,
} from '@/domain/escalation';
import { resolveHandoffAdapter, type HandoffResult } from '@/services/handoff';
import { dispatchEscalationNotice, type NotificationDelivery } from '@/services/clinic-notify';

type Turn = { role: 'user' | 'agent'; text: string; at: number };

export interface EscalationOutcome {
  escalated: boolean;
  reason: EscalationReason | null;
  action: HandoffAction;
  afterHours: boolean;
  handoff: HandoffResult | null;
  notifications: NotificationDelivery[];
}

const NOT_ESCALATED: EscalationOutcome = {
  escalated: false,
  reason: null,
  action: 'none',
  afterHours: false,
  handoff: null,
  notifications: [],
};

export interface HandleEscalationInput {
  turns: Turn[];
  outcome: 'booked' | 'no_slot' | 'escalated';
  reference: string;
  clinic?: ClinicConfig;
  callerNumber?: string | null;
  /** Force a system_failure escalation (mid-call hiccup). */
  forced?: 'system_failure' | null;
  nowMs?: number;
  clinicName?: string | null;
}

/**
 * Run the full escalation decision + handoff + clinic notice. Returns
 * NOT_ESCALATED when the rules say no human is needed; otherwise the chosen path
 * and its execution result. Never throws — a handoff/notify error degrades to a
 * recorded failure, it does not drop the caller.
 */
export async function handleEscalation(input: HandleEscalationInput): Promise<EscalationOutcome> {
  const clinic = input.clinic ?? DEFAULT_CLINIC;
  const decision = classifyEscalation({ turns: input.turns, outcome: input.outcome, forced: input.forced ?? null });
  if (!decision.escalate || !decision.reason) return NOT_ESCALATED;

  const nowMs = input.nowMs ?? Date.now();
  const afterHours = isAfterHours(clinic.hours, nowMs);
  const action = resolveHandoffAction({ reason: decision.reason, afterHours });

  let handoff: HandoffResult | null = null;
  try {
    handoff = await resolveHandoffAdapter().handle({
      kind: action === 'none' ? 'voicemail' : action,
      reference: input.reference,
      reason: decision.reason,
      callerNumber: input.callerNumber ?? null,
    });
  } catch (e) {
    handoff = { ok: false, kind: 'voicemail', simulated: true, error: (e as Error).message };
  }

  // Tell the clinic a human is needed (PHI-free; staff pull context from the queue).
  let notifications: NotificationDelivery[] = [];
  try {
    notifications = await dispatchEscalationNotice({ reference: input.reference, reason: decision.reason, clinicName: input.clinicName ?? clinic.name });
  } catch {
    notifications = [];
  }

  return { escalated: true, reason: decision.reason, action, afterHours, handoff, notifications };
}

/**
 * Mid-call graceful fallback (AC #3). The orchestrator calls this when a model or
 * telephony error interrupts a live call: it forces a system_failure escalation so
 * the caller is handed to a human (open hours) or offered a callback/voicemail
 * (after hours) — never dropped.
 */
export async function gracefulFallback(
  input: Omit<HandleEscalationInput, 'forced' | 'outcome'> & { outcome?: 'booked' | 'no_slot' | 'escalated' },
): Promise<EscalationOutcome> {
  return handleEscalation({ ...input, outcome: input.outcome ?? 'escalated', forced: 'system_failure' });
}
