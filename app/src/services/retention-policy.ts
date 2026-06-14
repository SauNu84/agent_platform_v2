/**
 * retention-policy.ts (SAU-285, Phase 1 · WS5) — config-driven PHI retention
 * windows for the scheduled disposal purge (the eng half of HIPAA gate SAU-272,
 * item 11). The windows themselves are the CISO-approved program doc §4 policy;
 * this module is where that policy becomes enforceable numbers.
 *
 * Two layers of configuration, narrowest-wins:
 *   1. Platform defaults — env-overridable (PHI_RETENTION_*), baked at import.
 *   2. Per-clinic override — `clinic.retention` jsonb (migration 0019), so each
 *      clinic BAA can negotiate a different window. Only positive integers count;
 *      anything missing/invalid falls back to the platform default.
 *
 * Windows (program doc §4 / SAU-285):
 *   - transcriptDays  call transcripts + audio + live event payloads → default 30d
 *   - intakeDays      patient intake + booking-outcome records       → default 1y (365d)
 *   - auditLogYears   phi_access_log                                  → 6y, RETAINED
 *
 * IMPORTANT: auditLogYears is informational here. The PHI access log is append-only
 * (§164.316(b)(2)) — the purge NEVER deletes it early; the DB blocks deletes by
 * privilege + trigger (migration 0018). The 6y value documents the legal retention
 * floor; a >6y disposal of audit rows is a separate, privileged operation.
 */

/** The resolved PHI retention windows that drive the purge. */
export interface RetentionWindows {
  /** call transcripts / audio / live event payloads — crypto-shredded after this. */
  transcriptDays: number;
  /** patient intake + booking-outcome records — purged after this (per-clinic). */
  intakeDays: number;
  /** phi_access_log legal retention floor (years). Retained, never purged early. */
  auditLogYears: number;
}

/** Default window (days/years), env-overridable. Positive integers only. */
function intEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * Platform-default windows from env (read once at import — a purge runs in a
 * fresh process, so caching is fine). Override per clinic via clinic.retention.
 */
export const DEFAULT_RETENTION: RetentionWindows = {
  transcriptDays: intEnv('PHI_RETENTION_TRANSCRIPT_DAYS', 30),
  intakeDays: intEnv('PHI_RETENTION_INTAKE_DAYS', 365),
  auditLogYears: intEnv('PHI_RETENTION_AUDIT_LOG_YEARS', 6),
};

/** A positive integer from an untrusted value, else the default. */
function posInt(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

/**
 * Resolve effective windows for a clinic: per-clinic `retention` jsonb override
 * (a subset of RetentionWindows) on top of the platform defaults. A null/absent/
 * malformed override yields the platform defaults unchanged.
 */
export function resolveClinicWindows(override?: unknown): RetentionWindows {
  const o = override && typeof override === 'object' ? (override as Record<string, unknown>) : {};
  return {
    transcriptDays: posInt(o.transcriptDays, DEFAULT_RETENTION.transcriptDays),
    intakeDays: posInt(o.intakeDays, DEFAULT_RETENTION.intakeDays),
    auditLogYears: posInt(o.auditLogYears, DEFAULT_RETENTION.auditLogYears),
  };
}
