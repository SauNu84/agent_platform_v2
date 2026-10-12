/**
 * Coach-memory retention purge — cron entrypoint (SAU-557 · CISO SAU-558 C1).
 *
 * Same shape as the PHI and debtor purge CLIs, but a SEPARATE job (by ruling): it
 * enforces ADR-004's coach-memory windows, not SAU-285's PHI windows. Schedule it
 * at least every 7 days (the ADR-004 hard-purge SLA), as the app_rw role:
 *
 *     DATABASE_URL=postgres://app_rw:...@.../db npm run purge:coach-memory               # apply
 *     DATABASE_URL=postgres://app_rw:...@.../db npm run purge:coach-memory -- --dry-run  # count only
 *
 * Exit code is non-zero on failure so a scheduler can alert.
 */
import { Pool } from 'pg';
import { purgeExpiredCoachMemory } from './coach-memory-purge';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run the coach-memory purge.');
  const dryRun = process.argv.includes('--dry-run');
  const pool = new Pool({ connectionString: url });
  try {
    const report = await purgeExpiredCoachMemory(pool, { dryRun });
    console.log(JSON.stringify(report));
    console.log(`[purge:coach-memory] ${dryRun ? 'would delete' : 'deleted'} ${report.memoriesPurged} expired memory row(s) (scoped by ${report.scopedBy}).`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[purge:coach-memory] failed:', e);
  process.exit(1);
});
