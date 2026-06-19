/**
 * SAU-333 (WS-2) — synthetic debtor ingestion + audit HMAC-chain math (pure, no DB).
 *
 * Proves the data-contract pieces WS-1 coordinates against:
 *   • validateDebtorRow/Rows: required fields, E.164 phone, numeric balance, and —
 *     critically — FAIL-CLOSED on an unknown IANA time zone (WS-1 guardrail 6).
 *   • parseCsv / parseDebtorList: CSV + JSON ingestion shapes.
 *   • the per-tenant HMAC hash chain: each row commits to the previous one, and a
 *     forged field / broken link is detectable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDebtorRow, validateDebtorRows, isValidTimeZone,
} from '@/domain/collections';
import { parseCsv, parseDebtorList, validateDebtorList } from '@/services/debtor-ingest';
import {
  collectionsAuditIntegrity, verifyCollectionsAuditIntegrity, type CollectionsAuditContent,
} from '@/domain/collections-audit';

const CLINIC = 'lender-1';

test('isValidTimeZone accepts IANA zones and rejects junk', () => {
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Europe/London'), true);
  assert.equal(isValidTimeZone('Mars/Phobos'), false);
  assert.equal(isValidTimeZone('EST5EDT-ish'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(undefined), false);
});

test('validateDebtorRow accepts a complete synthetic row and normalizes it', () => {
  const r = validateDebtorRow(
    { externalRef: 'A-100', name: 'Jane Doe', phone: '+14155550123', timezone: 'America/Los_Angeles', balance: '1,234.56', state: 'ca', consent: 'yes', doNotCall: 'no', dispute: 'false' },
    CLINIC, 1,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.debtor, {
    clinicId: CLINIC, externalRef: 'A-100', name: 'Jane Doe', phone: '+14155550123',
    balanceCents: 123456, timezone: 'America/Los_Angeles', state: 'CA',
    consent: true, optedOut: false, disputeOpen: false, validationNoticeSentAt: null,
  });
});

test('validateDebtorRow FAILS CLOSED on an unknown time zone (WS-1 fail-closed gate)', () => {
  const r = validateDebtorRow(
    { externalRef: 'A-1', name: 'X', phone: '+14155550000', timezone: 'Nowhere/Void', balance: '10' },
    CLINIC, 1,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors?.some((e) => /not a valid IANA zone/.test(e)), 'unknown TZ is rejected');
});

test('validateDebtorRow rejects missing/invalid required fields', () => {
  const missingTz = validateDebtorRow({ externalRef: 'B', name: 'Y', phone: '+14155551111', balance: '5' }, CLINIC, 1);
  assert.equal(missingTz.ok, false);
  assert.ok(missingTz.errors?.some((e) => /timezone is required/.test(e)));

  const badPhone = validateDebtorRow({ externalRef: 'C', name: 'Z', phone: '5550123', timezone: 'UTC', balance: '5' }, CLINIC, 1);
  assert.equal(badPhone.ok, false);
  assert.ok(badPhone.errors?.some((e) => /E\.164/.test(e)));

  const badBalance = validateDebtorRow({ externalRef: 'D', name: 'W', phone: '+14155552222', timezone: 'UTC', balance: 'NaN' }, CLINIC, 1);
  assert.equal(badBalance.ok, false);
  assert.ok(badBalance.errors?.some((e) => /balance/.test(e)));
});

test('parseCsv handles header + quoted fields, and validateDebtorRows partitions valid/rejected', () => {
  const csv = [
    'externalRef,name,phone,timezone,balance,state,consent',
    'A-1,"Doe, Jane",+14155550123,America/New_York,100.00,NY,true',
    'A-2,Bad TZ,+14155550124,Not/AZone,50,CA,false',
  ].join('\n');
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Doe, Jane', 'quoted comma preserved');

  const v = validateDebtorRows(rows, CLINIC);
  assert.equal(v.total, 2);
  assert.equal(v.valid.length, 1);
  assert.equal(v.rejected.length, 1);
  assert.equal(v.rejected[0].row, 2);
});

test('parseDebtorList reads a JSON array and a {debtors:[...]} envelope', () => {
  const arr = parseDebtorList('[{"externalRef":"J1","name":"A","phone":"+14155550123","timezone":"UTC","balance":1}]');
  assert.equal(arr.length, 1);
  const env = parseDebtorList('{"debtors":[{"externalRef":"J2"}]}');
  assert.equal(env.length, 1);
  const v = validateDebtorList('[{"externalRef":"J1","name":"A","phone":"+14155550123","timezone":"UTC","balance":1}]', CLINIC);
  assert.equal(v.valid.length, 1);
});

test('collections audit HMAC chain links rows and detects tampering', () => {
  const base = (over: Partial<CollectionsAuditContent>): CollectionsAuditContent => ({
    ts: '2026-06-17T14:00:00.000Z', clinicId: CLINIC, actorUserId: null, actorLabel: 'system',
    debtorRef: 'd1', eventType: 'dial_decision', decision: 'ALLOW', reason: null, refs: {}, ...over,
  });

  const row1 = base({ reason: null });
  const i1 = collectionsAuditIntegrity(row1, '');
  // row 2 commits to row 1's integrity (the chain link).
  const row2 = base({ eventType: 'call_outcome', decision: null, reason: 'no_answer' });
  const i2 = collectionsAuditIntegrity(row2, i1);

  assert.ok(verifyCollectionsAuditIntegrity(row1, '', i1), 'row1 verifies against empty prev');
  assert.ok(verifyCollectionsAuditIntegrity(row2, i1, i2), 'row2 verifies against row1 link');

  // Editing a field invalidates the tag.
  assert.equal(verifyCollectionsAuditIntegrity({ ...row2, reason: 'answered' }, i1, i2), false, 'forged reason fails');
  // Breaking the chain link (wrong prev) invalidates the tag — deletion/reorder is detectable.
  assert.equal(verifyCollectionsAuditIntegrity(row2, 'tampered-prev', i2), false, 'broken chain link fails');
});
