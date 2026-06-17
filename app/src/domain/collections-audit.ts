/**
 * collections-audit.ts (SAU-333, WS-2) — tamper-evidence for the compliance ledger.
 *
 * Guardrail 10 (the board-accepted collections boundary, SAU-330 §6) requires an
 * append-only, tamper-evident record of every dial decision, call outcome, and
 * opt-out — un-erasable even by a tenant admin. This module is the CONTENT-INTEGRITY
 * half, modeled on lib/phi-audit (SAU-275) but strengthened into a real HASH CHAIN:
 *
 *   integrity(row N) = HMAC( canonical(row N) ++ integrity(row N-1) )
 *
 * Each row commits to the one before it (per tenant), so deleting or reordering a
 * row — not just editing a field — breaks the chain at the next link. The HMAC uses
 * the server key (lib/crypto), so no tag can be re-forged off-box. The APPEND-ONLY
 * half (no deletes/updates, even for a tenant admin or the table owner) is enforced
 * at the DB by REVOKE + a trigger (migration 0022), exactly as phi_access_log does.
 *
 * `id` and `seq` are storage/ordering metadata and intentionally NOT covered by the
 * tag: the integrity protects the semantic compliance fact + its chain position,
 * not the surrogate key. The canonical form is a fixed-order JSON array so the HMAC
 * is reproducible across writer (PgStore) and verifier (compliance review / tests).
 */
import { hmac, verifyHmac } from '@/lib/crypto';
import type { CollectionsAuditEventType, DialDecision } from '@/domain/collections';

/** The HMAC-covered content of a compliance audit record (fixed field order). */
export interface CollectionsAuditContent {
  ts: string;
  clinicId: string;
  actorUserId: string | null;
  actorLabel: string;
  debtorRef: string;
  eventType: CollectionsAuditEventType;
  decision: DialDecision | null;
  reason: string | null;
  refs: Record<string, unknown>;
}

/**
 * Stable canonical string for the HMAC: the row's content followed by the previous
 * row's integrity tag (the chain link). Field order is fixed; refs is serialized
 * within the content array.
 */
export function collectionsAuditCanonical(c: CollectionsAuditContent, prevIntegrity: string): string {
  return JSON.stringify([
    c.ts, c.clinicId, c.actorUserId, c.actorLabel, c.debtorRef,
    c.eventType, c.decision, c.reason, c.refs, prevIntegrity,
  ]);
}

/** Compute the base64 HMAC integrity tag linking this row to the previous one. */
export function collectionsAuditIntegrity(c: CollectionsAuditContent, prevIntegrity: string): string {
  return hmac(collectionsAuditCanonical(c, prevIntegrity));
}

/** Verify a stored row's tag matches its content + the recorded previous-link. */
export function verifyCollectionsAuditIntegrity(
  c: CollectionsAuditContent,
  prevIntegrity: string,
  integrity: string,
): boolean {
  return verifyHmac(collectionsAuditCanonical(c, prevIntegrity), integrity);
}
