/**
 * SAU-334 — WS-3: outbound dialer + voice orchestration (synthetic).
 *
 * Proves the WS-3 acceptance criteria, end-to-end through the in-memory store, the
 * WS-1 engine, and the WS-2 audit ledger:
 *
 *   1. The dial path is GATED by WS-1: a BLOCK decision (out-of-window, opt-out)
 *      prevents origination — the origination seam is never reached.
 *   2. The required disclosure (guardrail 5) is the first thing played on EVERY
 *      connected call.
 *   3. The voicemail path uses the limited-content script (guardrail 8) with no debt
 *      amount / debt language.
 *   4. Synthetic-only: a real call is impossible unless the SAU-331 go-live gate flag
 *      is set — the factory fails closed to the simulated dialer.
 *   5. Every dial decision and every call outcome is appended to the WS-2 ledger.
 *
 * Synthetic debtors / owned test numbers only (SAU-328). Nothing here places a real call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@/db/memory-store';
import type { NewDebtor } from '@/domain/collections';
import { CollectionsDialer } from '@/services/collections-dialer';
import {
  MockOutboundDialer,
  resolveOutboundDialer,
  type OutboundCallStatus,
  type OutboundDialRequest,
  type OutboundCallResult,
  type OutboundDialer,
} from '@/services/telephony/outbound-origination';
import {
  COLLECTIONS_REQUIRED_DISCLOSURE,
  buildVoicemailScript,
  screenVoicemailForDebtDetails,
  assertNoDebtDetails,
} from '@/domain/collections-voice';

// Deterministic instant in America/New_York: 2026-06-17 (Wed) 2 PM ET — in-window.
const WED_2PM_ET = Date.parse('2026-06-17T14:00:00-04:00');
const WED_8PM_ET = Date.parse('2026-06-17T20:00:00-04:00'); // out of the 9–5 window
const at = (ms: number) => () => ms;

const CLINIC = 'lender-1';

function newDebtor(over: Partial<NewDebtor> = {}): NewDebtor {
  return {
    clinicId: CLINIC,
    externalRef: over.externalRef ?? 'ACME-1',
    name: 'Synthetic Debtor',
    phone: '+12125550100',
    balanceCents: 125_00,
    timezone: 'America/New_York',
    state: 'NY',
    consent: true,
    optedOut: false,
    disputeOpen: false,
    ...over,
  };
}

/** An origination spy: records calls and refuses to dial if asked to misbehave. */
function spyDialer(status: OutboundCallStatus = 'connected'): OutboundDialer & { calls: OutboundDialRequest[] } {
  const calls: OutboundDialRequest[] = [];
  return {
    calls,
    label: 'spy',
    simulated: true,
    async originate(req: OutboundDialRequest): Promise<OutboundCallResult> {
      calls.push(req);
      return {
        callId: req.callId ?? 'spy-1',
        status,
        hadConversation: status === 'connected',
        openingLine: status === 'connected' ? req.disclosure : null,
        vendorLabel: 'spy',
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// AC1 — WS-1 gates the dial: BLOCK ⇒ origination is unreachable
// ──────────────────────────────────────────────────────────────────────────

test('opt-out debtor is BLOCKED and never originated', async () => {
  const store = new MemoryStore();
  const debtor = await store.upsertDebtor(newDebtor({ optedOut: true }));
  const origination = spyDialer('connected');
  const dialer = new CollectionsDialer({ store, origination, now: at(WED_2PM_ET) });

  const res = await dialer.attemptDial(debtor.id);

  assert.equal(res.decision, 'BLOCK');
  assert.equal(res.originated, false);
  assert.equal(res.call, null);
  assert.ok(res.reasons.some((r) => r.code === 'opted_out'));
  assert.equal(origination.calls.length, 0, 'origination must NOT be reached on a BLOCK');

  // A dial_decision BLOCK row is written; NO call_outcome row.
  const audit = await store.listCollectionsAudit({ clinicId: CLINIC, debtorRef: debtor.id });
  assert.equal(audit.filter((a) => a.eventType === 'dial_decision' && a.decision === 'BLOCK').length, 1);
  assert.equal(audit.filter((a) => a.eventType === 'call_outcome').length, 0);
});

test('out-of-window dial is BLOCKED and never originated', async () => {
  const store = new MemoryStore();
  const debtor = await store.upsertDebtor(newDebtor());
  const origination = spyDialer('connected');
  const dialer = new CollectionsDialer({ store, origination, now: at(WED_8PM_ET) });

  const res = await dialer.attemptDial(debtor.id);

  assert.equal(res.decision, 'BLOCK');
  assert.equal(res.originated, false);
  assert.ok(res.reasons.some((r) => r.code === 'outside_calling_window'));
  assert.equal(origination.calls.length, 0);
});

test('unknown debtor fails closed (BLOCK, no origination)', async () => {
  const store = new MemoryStore();
  const origination = spyDialer('connected');
  const dialer = new CollectionsDialer({ store, origination, now: at(WED_2PM_ET) });

  const res = await dialer.attemptDial('does-not-exist');

  assert.equal(res.decision, 'BLOCK');
  assert.equal(res.originated, false);
  assert.equal(origination.calls.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// AC2 — required disclosure at the start of every connected call (guardrail 5)
// ──────────────────────────────────────────────────────────────────────────

test('connected call injects the required disclosure as its first utterance', async () => {
  const store = new MemoryStore();
  const debtor = await store.upsertDebtor(newDebtor());
  const dialer = new CollectionsDialer({
    store,
    origination: new MockOutboundDialer({ simulate: () => 'connected' }),
    now: at(WED_2PM_ET),
  });

  const res = await dialer.attemptDial(debtor.id);

  assert.equal(res.decision, 'ALLOW');
  assert.equal(res.originated, true);
  assert.equal(res.call?.status, 'connected');
  assert.equal(res.call?.openingLine, COLLECTIONS_REQUIRED_DISCLOSURE);
  assert.equal(res.disclosure, COLLECTIONS_REQUIRED_DISCLOSURE);

  // Both a dial_decision ALLOW and a call_outcome row land in the ledger.
  const audit = await store.listCollectionsAudit({ clinicId: CLINIC, debtorRef: debtor.id });
  assert.equal(audit.filter((a) => a.eventType === 'dial_decision' && a.decision === 'ALLOW').length, 1);
  const outcome = audit.find((a) => a.eventType === 'call_outcome');
  assert.equal(outcome?.reason, 'connected');
  // The audit refs carry counts/status only — never PII (no phone/name/balance).
  assert.ok(!JSON.stringify(audit).includes(debtor.phone));
  assert.ok(!JSON.stringify(audit).includes(debtor.name));
});

test('disclosure is present on EVERY connected call across a batch', async () => {
  const store = new MemoryStore();
  await store.upsertDebtor(newDebtor({ externalRef: 'A', phone: '+12125550101' }));
  await store.upsertDebtor(newDebtor({ externalRef: 'B', phone: '+13125550102', timezone: 'America/Chicago' }));
  await store.upsertDebtor(newDebtor({ externalRef: 'C', phone: '+14155550103', timezone: 'America/Los_Angeles' }));
  const dialer = new CollectionsDialer({
    store,
    origination: new MockOutboundDialer({ simulate: () => 'connected' }),
    now: at(WED_2PM_ET),
  });

  const results = await dialer.attemptDialForClinic(CLINIC);
  const connected = results.filter((r) => r.call?.status === 'connected');
  assert.equal(connected.length, 3);
  for (const r of connected) {
    assert.equal(r.call?.openingLine, COLLECTIONS_REQUIRED_DISCLOSURE, 'every connected call opens with the disclosure');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// AC3 — voicemail uses the limited-content script (guardrail 8)
// ──────────────────────────────────────────────────────────────────────────

test('voicemail path uses the limited-content script with no debt details', async () => {
  const store = new MemoryStore();
  const debtor = await store.upsertDebtor(newDebtor());
  const dialer = new CollectionsDialer({
    store,
    origination: new MockOutboundDialer({ simulate: () => 'voicemail' }),
    now: at(WED_2PM_ET),
    agencyName: 'Acme Recovery',
    callbackNumber: '+18005551234',
  });

  const res = await dialer.attemptDial(debtor.id);

  assert.equal(res.decision, 'ALLOW');
  assert.equal(res.call?.status, 'voicemail');
  assert.equal(res.disclosure, null, 'no connected disclosure on a voicemail');
  assert.ok(res.voicemailScript, 'a voicemail script was used');
  // Guardrail 8: no debt language, no balance, no dollar amount.
  assert.equal(screenVoicemailForDebtDetails(res.voicemailScript!).ok, true);
  assert.ok(!res.voicemailScript!.includes(String(debtor.balanceCents)));
  assert.ok(!/\$/.test(res.voicemailScript!));
  assert.ok(res.voicemailScript!.includes('+18005551234'), 'callback number is present');

  const outcome = (await store.listCollectionsAudit({ clinicId: CLINIC, debtorRef: debtor.id }))
    .find((a) => a.eventType === 'call_outcome');
  assert.equal(outcome?.reason, 'voicemail');
});

// ──────────────────────────────────────────────────────────────────────────
// AC4 — synthetic-only: the go-live gate (SAU-331) is required for a live dial
// ──────────────────────────────────────────────────────────────────────────

test('resolveOutboundDialer fails closed to the mock without the go-live gate', () => {
  const saved = {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    confirmed: process.env.COLLECTIONS_LIVE_DIAL_CONFIRMED,
    provider: process.env.TELEPHONY_PROVIDER,
  };
  try {
    // Even WITH Twilio credentials, an unset go-live flag ⇒ simulated dialer.
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    delete process.env.COLLECTIONS_LIVE_DIAL_CONFIRMED;
    delete process.env.TELEPHONY_PROVIDER;
    assert.equal(resolveOutboundDialer().simulated, true);

    // The flag alone (no creds) is also not enough — still simulated.
    process.env.COLLECTIONS_LIVE_DIAL_CONFIRMED = 'true';
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    assert.equal(resolveOutboundDialer().simulated, true);
  } finally {
    restore('TWILIO_ACCOUNT_SID', saved.sid);
    restore('TWILIO_AUTH_TOKEN', saved.token);
    restore('COLLECTIONS_LIVE_DIAL_CONFIRMED', saved.confirmed);
    restore('TELEPHONY_PROVIDER', saved.provider);
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ──────────────────────────────────────────────────────────────────────────
// Voice script units (guardrails 5 & 8)
// ──────────────────────────────────────────────────────────────────────────

test('required disclosure states it is a debt collector attempting to collect', () => {
  const d = COLLECTIONS_REQUIRED_DISCLOSURE.toLowerCase();
  assert.ok(d.includes('debt collector'));
  assert.ok(d.includes('attempt to collect a debt'));
});

test('limited-content voicemail builder produces no debt details', () => {
  const script = buildVoicemailScript({ agencyName: 'Acme Recovery', callbackNumber: '+18005551234' });
  assert.equal(screenVoicemailForDebtDetails(script).ok, true);
  assert.ok(script.includes('Acme Recovery'));
  assert.ok(script.includes('+18005551234'));
});

test('assertNoDebtDetails throws on a script that reveals a debt', () => {
  assert.throws(() => assertNoDebtDetails('You owe a balance of $125.00. Please pay.'));
  assert.equal(screenVoicemailForDebtDetails('Your account balance is $125').ok, false);
});
