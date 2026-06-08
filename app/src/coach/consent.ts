/**
 * Consent for Coach memory features (ADR-004 §User controls).
 *
 * Consent is the legal basis for persistent memory + audio retention. It is
 * captured BEFORE any memory row is written, granular (two independent toggles),
 * and recorded append-only (`consent_record`) so the exact wording agreed to is
 * provable (`policy_text_hash`) and state is reconstructable at any timestamp.
 */
import { createHash } from 'node:crypto';
import type { ConsentType, ConsentState, Store } from '@/db/store';

export const CONSENT_POLICY_VERSION = '2026-06-08';

/** The exact plain-language disclosure shown at the consent gate (ADR-004 draft copy). */
export const CONSENT_POLICY_TEXT =
  'To pick up where you left off, this coach can remember a summary of your sessions ' +
  'and key facts you share (e.g. goals, preferences) — only for this coach, never ' +
  'shared with other users or coaches. Summaries are kept up to 12 months; facts ' +
  'until you delete them or 24 months of inactivity. You can view, export, or delete ' +
  'everything any time in Memory settings, and turn this off whenever you like. ' +
  'Optionally, this coach can also keep your audio recordings (up to 90 days).';

export const CONSENT_POLICY_TEXT_HASH = createHash('sha256')
  .update(CONSENT_POLICY_TEXT, 'utf8')
  .digest('hex');

/** The scope string for a per-coach consent record. */
export function coachScope(coachId: string): string {
  return `coach:${coachId}`;
}

export interface ConsentChange {
  store: Store;
  userId: string;
  coachId: string;
  consentType: ConsentType;
  action: 'granted' | 'revoked';
  locale?: string | null;
  uiSurface?: string | null;
}

/** Record a consent grant/revoke (append-only) + an audit event. */
export async function recordConsentChange(c: ConsentChange): Promise<ConsentState> {
  const scope = coachScope(c.coachId);
  await c.store.recordConsent({
    userId: c.userId,
    scope,
    consentType: c.consentType,
    action: c.action,
    policyVersion: CONSENT_POLICY_VERSION,
    policyTextHash: CONSENT_POLICY_TEXT_HASH,
    locale: c.locale ?? null,
    uiSurface: c.uiSurface ?? 'coach_detail',
  });
  await c.store.recordAuditEvent({
    actor: `user:${c.userId}`,
    event: c.action === 'granted' ? 'consent.grant' : 'consent.revoke',
    subjectUserId: c.userId,
    coachId: c.coachId,
    refs: { consentType: c.consentType, scope, policyVersion: CONSENT_POLICY_VERSION },
  });
  return c.store.getConsentState(c.userId, scope);
}

export async function getCoachConsent(store: Store, userId: string, coachId: string): Promise<ConsentState> {
  return store.getConsentState(userId, coachScope(coachId));
}
