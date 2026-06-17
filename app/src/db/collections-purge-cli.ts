/**
 * Collections debtor retention purge — cron entrypoint (SAU-333, WS-2).
 *
 * Wires the scheduled synthetic-debtor disposal (collections-retention-purge.ts) to
 * a runnable command, the same shape as the PHI purge CLI (SAU-285). Schedule it on
 * a recurring cadence with maintenance DB credentials:
 *
 *     DATABASE_URL=postgres://... npm run purge:debtors               # apply
 *     DATABASE_URL=postgres://... npm run purge:debtors -- --dry-run  # report only
 *
 * The window defaults to 365d (env COLLECTIONS_RETENTION_DEBTOR_DAYS), with an
 * optional per-clinic override (clinic.retention.debtorDays). Exit code is non-zero
 * on failure so a scheduler can alert. Each disposal is recorded in the append-only
 * collections_audit_log (counts/ids only — never PII).
 */
import { Pool } from 'pg';
import { purgeExpiredDebtors } from './collections-retention-purge';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run the collections debtor purge.');
  const dryRun = process.argv.includes('--dry-run');

  const pool = new Pool({ connectionString: url });
  try {
    console.log(`[purge:debtors] ${dryRun ? 'DRY RUN — ' : ''}disposing synthetic debtors past their retention window.`);
    const report = await purgeExpiredDebtors(pool, { dryRun });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `[purge:debtors] ${dryRun ? 'would dispose' : 'disposed'}: ` +
        `${report.debtorsPurged} debtor(s) across ${report.clinicsScanned} lender tenant(s). ` +
        `collections_audit_log retained: ${report.auditLogRetained} row(s).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[purge:debtors] failed:', e);
  process.exit(1);
});
