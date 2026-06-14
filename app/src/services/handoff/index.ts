/**
 * Handoff adapter factory (SAU-273, WS4). Resolves the key-gated Twilio transport
 * when telephony credentials are present, else FAILS SOFT to the deterministic
 * mock — so a key-less environment still routes (and never drops) a caller.
 * `HANDOFF_PROVIDER=mock` forces the mock even with keys (synthetic Phase-1 demo).
 */
import type { HandoffAdapter } from './handoff-adapter';
import { MockHandoffAdapter } from './mock-handoff';
import { TwilioHandoffAdapter, readTwilioHandoffConfig } from './twilio-handoff';

export type { HandoffAdapter, HandoffRequest, HandoffResult, HandoffKind } from './handoff-adapter';
export { mockHandoffLog, __resetMockHandoff } from './mock-handoff';

export function resolveHandoffAdapter(): HandoffAdapter {
  if ((process.env.HANDOFF_PROVIDER ?? 'auto').toLowerCase() !== 'mock') {
    const cfg = readTwilioHandoffConfig();
    if (cfg) return new TwilioHandoffAdapter(cfg);
  }
  return new MockHandoffAdapter();
}
