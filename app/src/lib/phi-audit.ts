/**
 * phi-audit.ts (SAU-275 / WS5) — tamper-evidence for the PHI access log.
 *
 * Every `phi_access_log` row is HMAC-SHA256 stamped over its canonical content at
 * write time (lib/crypto under the platform key). Editing any logged field —
 * who/what/when — invalidates the tag, and the tag cannot be re-forged without the
 * server key. This is the content-integrity half of tamper-evidence; the
 * append-only half (no deletes/reorders) is enforced at the DB by privileges + a
 * trigger (migration 0018).
 *
 * The canonical form is a fixed-order JSON array so the HMAC is stable and
 * reproducible across writer (PgStore) and verifier (compliance review / tests).
 * `id` and `seq` are storage/ordering metadata and intentionally NOT covered:
 * the integrity tag protects the semantic access fact, not the row's surrogate key.
 */
import { hmac, verifyHmac } from '@/lib/crypto';

/** The HMAC-covered content of a PHI access record (fixed field order). */
export interface PhiAuditContent {
  ts: string;
  actorUserId: string | null;
  actorLabel: string;
  action: 'read' | 'write' | 'purge';
  entity: string;
  entityId: string | null;
  clinicId: string | null;
  refs: Record<string, unknown>;
}

/** Stable canonical string for HMAC (order fixed; refs serialized last). */
export function phiAuditCanonical(c: PhiAuditContent): string {
  return JSON.stringify([
    c.ts, c.actorUserId, c.actorLabel, c.action, c.entity, c.entityId, c.clinicId, c.refs,
  ]);
}

/** Compute the base64 HMAC integrity tag for a PHI access record. */
export function phiAuditIntegrity(c: PhiAuditContent): string {
  return hmac(phiAuditCanonical(c));
}

/** Verify a stored row's integrity tag matches its content (tamper check). */
export function verifyPhiAuditIntegrity(c: PhiAuditContent, integrity: string): boolean {
  return verifyHmac(phiAuditCanonical(c), integrity);
}
