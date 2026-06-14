/**
 * PHI retention purge — cron entrypoint (SAU-285, Phase 1 · WS5).
 *
 * Wires the scheduled disposal sweep (retention-purge.ts) to a runnable command,
 * the same shape as the migrate/seed CLIs. A production deployment schedules this
 * on a recurring cadence (e.g. a nightly Kubernetes CronJob, ECS scheduled task, or
 * `cron` line) with maintenance DB credentials:
 *
 *     DATABASE_URL=postgres://... npm run purge:phi            # apply
 *     DATABASE_URL=postgres://... npm run purge:phi -- --dry-run   # report only
 *
 * Windows come from services/retention-policy (env defaults + per-clinic override).
 * Exit code is non-zero on failure so a scheduler can alert. The JSON report is the
 * run's disposal evidence (counts only — never PHI); the per-entity disposal is also
 * recorded in the append-only phi_access_log.
 */
import { Pool } from 'pg';
import { purgeExpiredPhi } from './retention-purge';
import { DEFAULT_RETENTION } from '@/services/retention-policy';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run the PHI retention purge.');
  const dryRun = process.argv.includes('--dry-run');

  const pool = new Pool({ connectionString: url });
  try {
    console.log(
      `[purge:phi] ${dryRun ? 'DRY RUN — ' : ''}windows: transcripts ${DEFAULT_RETENTION.transcriptDays}d, ` +
        `intake ${DEFAULT_RETENTION.intakeDays}d, audit-log ${DEFAULT_RETENTION.auditLogYears}y (retained). ` +
        `Per-clinic overrides apply where set.`,
    );
    const report = await purgeExpiredPhi(pool, { dryRun });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `[purge:phi] ${dryRun ? 'would dispose' : 'disposed'}: ` +
        `${report.transcriptsShredded} transcript(s) shredded, ` +
        `${report.sessionEventsDeleted} event payload(s) deleted, ` +
        `${report.intakeRecordsPurged} intake record(s) purged across ${report.clinicsScanned} clinic(s). ` +
        `phi_access_log retained: ${report.phiAccessLogRetained} row(s).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[purge:phi] failed:', e);
  process.exit(1);
});
