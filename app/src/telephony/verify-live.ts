/**
 * Live telephony activation check (SAU-292).
 *
 * Confirms the wired Twilio creds (board-provisioned, in `app/.env.local`) flip
 * every clinic-agent seam off its mock and onto the real Twilio adapter — WITHOUT
 * ever printing a secret. We report presence (true/false) and non-secret fields
 * (selected adapter, label, masked SID tail, the resolved public bridge URL), never
 * the auth token or full key material.
 *
 * Run: `npm run verify:telephony` (loads `.env.local` via --env-file-if-exists).
 *
 * Exit code is 0 when telephony + handoff activate live; the SMS seam additionally
 * needs `TWILIO_SMS_FROM` (the claimed number) so it is reported but not gating.
 */
import { getTelephonyAdapter, getTwilioConfig, bridgeWsUrlFor } from '@/services/telephony';
import { resolveHandoffAdapter } from '@/services/handoff';
import { resolveSmsAdapter } from '@/services/notifications';

function mask(v: string | undefined): string {
  if (!v) return '(absent)';
  if (v.length <= 6) return '••••';
  return `${v.slice(0, 2)}…${v.slice(-4)} (len ${v.length})`;
}

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

function main() {
  console.log('=== SAU-292 live telephony activation check ===\n');

  console.log('Env presence (booleans only, never values):');
  line('TWILIO_ACCOUNT_SID', !!process.env.TWILIO_ACCOUNT_SID);
  line('TWILIO_AUTH_TOKEN', !!process.env.TWILIO_AUTH_TOKEN);
  line('TWILIO_PHONE_NUMBER', process.env.TWILIO_PHONE_NUMBER || '(absent — claim trial #)');
  line('TWILIO_SMS_FROM', process.env.TWILIO_SMS_FROM || '(absent — needed for live SMS)');
  line('TWILIO_TRANSFER_TO', process.env.TWILIO_TRANSFER_TO || '(absent — handoff→voicemail)');
  line('TELEPHONY_PUBLIC_URL', process.env.TELEPHONY_PUBLIC_URL || '(absent — needs tunnel)');
  line('OPENAI_API_KEY', !!process.env.OPENAI_API_KEY);
  console.log('');

  const cfg = getTwilioConfig();
  console.log('Twilio config (masked):');
  line('account SID', mask(cfg?.accountSid));
  line('auth token', cfg?.authToken ? '(present, not shown)' : '(absent)');
  line('phone number', cfg?.phoneNumber || '(none)');
  line('bridge public URL', cfg?.bridgePublicUrl || '(none)');
  line('verify signatures', cfg?.verifySignatures);
  if (cfg) {
    line('sample bridge wss', bridgeWsUrlFor(cfg, 'clinic-intake-booking') || '(no public URL → fail-soft)');
  }
  console.log('');

  const tel = getTelephonyAdapter();
  const handoff = resolveHandoffAdapter();
  const sms = resolveSmsAdapter();

  console.log('Resolved adapters (simulated=false ⇒ LIVE Twilio):');
  line('telephony', `${tel.label}  simulated=${tel.simulated}`);
  line('handoff', `${handoff.label}  simulated=${handoff.simulated}`);
  line('sms', `${sms.label}  simulated=${sms.simulated}`);
  console.log('');

  const telLive = tel.simulated === false;
  const handoffLive = handoff.simulated === false;
  const smsLive = sms.simulated === false;

  console.log('Verdict:');
  line('telephony LIVE', telLive ? '✅' : '❌');
  line('handoff LIVE', handoffLive ? '✅' : '❌');
  line('sms LIVE', smsLive ? '✅' : `⚠️ mock (set TWILIO_SMS_FROM to the claimed number)`);
  console.log('');

  if (telLive && handoffLive) {
    console.log('PASS — wired creds activate the live Twilio telephony + handoff adapters.');
    process.exit(0);
  }
  console.log('FAIL — expected live telephony + handoff with creds present.');
  process.exit(1);
}

main();
