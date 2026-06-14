/**
 * Deterministic mock handoff transport (SAU-273, WS4) — the fail-soft default.
 *
 * No credentials, no live call: it returns a successful, deterministic result for
 * each handoff kind and records it in an in-memory log so tests and the dev UI can
 * assert what the bridge WOULD have done. This lets the full escalation path run
 * offline (AC #3: a key-less / mock environment still never drops a caller).
 */
import type { HandoffAdapter, HandoffRequest, HandoffResult } from './handoff-adapter';

export interface HandoffLogEntry extends HandoffRequest {
  providerId: string;
}

const LOG: HandoffLogEntry[] = [];

export function mockHandoffLog(): readonly HandoffLogEntry[] {
  return LOG;
}

export function __resetMockHandoff(): void {
  LOG.length = 0;
}

export class MockHandoffAdapter implements HandoffAdapter {
  readonly label = 'Simulated handoff';
  readonly simulated = true;

  async handle(req: HandoffRequest): Promise<HandoffResult> {
    const providerId = `sim-${req.kind}-${LOG.length + 1}`;
    LOG.push({ ...req, providerId });
    const instruction =
      req.kind === 'warm_transfer'
        ? '<Response><Say>Connecting you to our front desk.</Say><Dial>[clinic-staff]</Dial></Response>'
        : req.kind === 'voicemail'
          ? '<Response><Say>Our office is closed. Please leave a message after the tone.</Say><Record/></Response>'
          : '<Response><Say>We\'ll call you back shortly. Goodbye.</Say><Hangup/></Response>';
    return { ok: true, kind: req.kind, instruction, providerId, simulated: true };
  }
}
