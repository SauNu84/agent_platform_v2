/**
 * Telephony adapter factory (SAU-270). Resolves the live Twilio adapter when
 * credentials are configured, else FAILS SOFT to the mock — so a key-less
 * environment answers inbound webhooks with a polite no-op and never crashes
 * (AC #2). Mirrors `getCalendarAdapter()` (SAU-267).
 */
import type { TelephonyAdapter } from './telephony-adapter';
import { MockTelephonyAdapter } from './mock-telephony';
import { TwilioTelephonyAdapter } from './twilio-telephony';
import { resolveTwilioConfig, type PhoneIntegrationSetting, type TwilioConfig } from './twilio-config';
export { signBridgeStream, verifyBridgeStream, authorizeBridgeStream, SeenStreamSignatures, type BridgeAdmitAuth, BRIDGE_STREAM_TTL_SEC, type BridgeStreamParams, type BridgeAuthResult } from './bridge-auth';

export type {
  TelephonyAdapter,
  InboundCallAnswer,
  InboundCallContext,
} from './telephony-adapter';
export { MockTelephonyAdapter } from './mock-telephony';
export { TwilioTelephonyAdapter } from './twilio-telephony';
export {
  resolveTwilioConfig,
  bridgeWsUrlFor,
  bridgeStreamFor,
  bridgeAuthRequired,
  type BridgeStream,
  bridgeServerPort,
  BRIDGE_WS_PATH,
  type TwilioConfig,
  type PhoneIntegrationSetting,
} from './twilio-config';

/**
 * Resolve the active telephony adapter. `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`
 * (env, or the SAU-253 phone-integration setting passed in) selects the real Twilio
 * adapter; otherwise the simulated mock. `TELEPHONY_PROVIDER=mock` forces the mock
 * even with credentials (parity with `CALENDAR_PROVIDER=mock`).
 */
export function getTelephonyAdapter(setting?: PhoneIntegrationSetting | null): TelephonyAdapter {
  const provider = (process.env.TELEPHONY_PROVIDER ?? 'auto').toLowerCase();
  if (provider !== 'mock') {
    const cfg = resolveTwilioConfig(setting);
    if (cfg) return new TwilioTelephonyAdapter(cfg);
  }
  return new MockTelephonyAdapter();
}

/** Resolve the live Twilio config (or null) without constructing an adapter. */
export function getTwilioConfig(setting?: PhoneIntegrationSetting | null): TwilioConfig | null {
  if ((process.env.TELEPHONY_PROVIDER ?? 'auto').toLowerCase() === 'mock') return null;
  return resolveTwilioConfig(setting);
}
