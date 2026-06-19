/**
 * SAU-356 (WS-1 F2) — per-debtor §1692g validation-notice tracking.
 *
 * Finding F2 from the SAU-353 gate verification: the dispute-PAUSE half of §6 #9 was
 * enforced, but there was no tracking of the §1692g validation-notice obligation itself
 * (notice-sent timestamp + the derived 30-day dispute window). These tests pin the new
 * data-model surface: ingest parsing, the +30d window derivation, the within-window
 * predicate, and the reporting status classification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDebtorRow,
  disputeWindowEndsAt,
  isWithinValidationWindow,
  validationNoticeStatus,
  VALIDATION_DISPUTE_WINDOW_DAYS,
} from '@/domain/collections';

const DAY = 86_400_000;

/** A minimally-valid ingest row (passes the required-field gates). */
function baseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalRef: 'acct-001',
    name: 'Synthetic Person',
    phone: '+12125550100',
    timezone: 'America/New_York',
    balance: '125.00',
    ...over,
  };
}

test('ingest: validationNoticeSentAt is parsed + normalized to ISO when present', () => {
  const r = validateDebtorRow(baseRow({ validationNoticeSentAt: '2026-06-01T12:00:00Z' }), 'lender-1', 0);
  assert.equal(r.ok, true);
  assert.equal(r.debtor?.validationNoticeSentAt, '2026-06-01T12:00:00.000Z');
});

test('ingest: snake_case alias is accepted', () => {
  const r = validateDebtorRow(baseRow({ validation_notice_sent_at: '2026-06-01' }), 'lender-1', 0);
  assert.equal(r.ok, true);
  assert.equal(r.debtor?.validationNoticeSentAt, '2026-06-01T00:00:00.000Z');
});

test('ingest: absent or invalid notice → null (not a hard reject)', () => {
  assert.equal(validateDebtorRow(baseRow(), 'lender-1', 0).debtor?.validationNoticeSentAt, null);
  const bad = validateDebtorRow(baseRow({ validationNoticeSentAt: 'not-a-date' }), 'lender-1', 0);
  assert.equal(bad.ok, true);
  assert.equal(bad.debtor?.validationNoticeSentAt, null);
});

test('disputeWindowEndsAt: derived = sent + 30 days; null when no notice', () => {
  const sent = '2026-06-01T00:00:00.000Z';
  const ends = disputeWindowEndsAt({ validationNoticeSentAt: sent });
  assert.equal(ends, new Date(Date.parse(sent) + VALIDATION_DISPUTE_WINDOW_DAYS * DAY).toISOString());
  assert.equal(disputeWindowEndsAt({ validationNoticeSentAt: null }), null);
  assert.equal(disputeWindowEndsAt({ validationNoticeSentAt: 'garbage' }), null);
});

test('isWithinValidationWindow: true inside 30d, false on/after the boundary, false if unsent', () => {
  const sentMs = Date.parse('2026-06-01T00:00:00Z');
  const sent = new Date(sentMs).toISOString();
  assert.equal(isWithinValidationWindow({ validationNoticeSentAt: sent }, sentMs + 1 * DAY), true);
  assert.equal(isWithinValidationWindow({ validationNoticeSentAt: sent }, sentMs + 29 * DAY), true);
  assert.equal(isWithinValidationWindow({ validationNoticeSentAt: sent }, sentMs + 30 * DAY), false); // exclusive end
  assert.equal(isWithinValidationWindow({ validationNoticeSentAt: sent }, sentMs - 1), false); // before send
  assert.equal(isWithinValidationWindow({ validationNoticeSentAt: null }, sentMs), false);
});

test('validationNoticeStatus: not_sent | in_window | window_elapsed', () => {
  const sentMs = Date.parse('2026-06-01T00:00:00Z');
  const sent = new Date(sentMs).toISOString();
  assert.equal(validationNoticeStatus({ validationNoticeSentAt: null }, sentMs), 'not_sent');
  assert.equal(validationNoticeStatus({ validationNoticeSentAt: sent }, sentMs + 10 * DAY), 'in_window');
  assert.equal(validationNoticeStatus({ validationNoticeSentAt: sent }, sentMs + 40 * DAY), 'window_elapsed');
});
