/**
 * SAU-335 (WS-4) — seed two isolated demo LENDERS + synthetic debtors + call-attempt
 * outcomes for the collections ops dashboard live-verify + screenshot.
 *
 * Runs through the REAL store (PgStore) so PII is encrypted at rest, the compliance
 * ledger is HMAC-hash-chained, and "next eligible dial" is computed by WS-1's engine —
 * exactly as production would. Run against the dev DB as the owner/superuser role
 * (RLS bypassed for seeding, like seed-cli's admin actor):
 *
 *   DATABASE_URL=postgres://agent:agent@localhost:5433/agent_platform \
 *     SETTINGS_ENCRYPTION_KEY=<hex> npm run seed:collections
 *
 * Idempotent on the lender slugs. Synthetic / test data only — nothing here calls anyone.
 */
import { Pool } from 'pg';
import { PgStore } from '@/db/pg-store';
import type { CollectionsOutcome } from '@/domain/collections-outcome';

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error('DATABASE_URL is required (owner role) — e.g. postgres://agent:agent@localhost:5433/agent_platform');
  process.exit(1);
}

const DAY = 24 * 60 * 60 * 1000;
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

interface SeedDebtor {
  externalRef: string;
  name: string;
  phone: string;
  balanceCents: number;
  timezone: string;
  state: string | null;
  consent?: boolean;
  optedOut?: boolean;
  disputeOpen?: boolean;
  /** attempts to record, as [outcome, daysAgo] (daysAgo from now). */
  attempts?: Array<[CollectionsOutcome, number]>;
}

interface SeedLender {
  slug: string;
  name: string;
  debtors: SeedDebtor[];
}

const LENDERS: SeedLender[] = [
  {
    slug: 'atlas-lending',
    name: 'Atlas Lending',
    debtors: [
      { externalRef: 'ATL-1001', name: 'Jordan Avery', phone: '+12125550111', balanceCents: 124500, timezone: NY, state: 'NY', consent: true, attempts: [['no_answer', 20], ['voicemail_left', 6]] },
      { externalRef: 'ATL-1002', name: 'Sam Brooks', phone: '+12125550112', balanceCents: 38000, timezone: NY, state: 'NY', consent: true, attempts: [['contacted', 30], ['promised_to_pay', 2]] },
      { externalRef: 'ATL-1003', name: 'Riley Chen', phone: '+13125550113', balanceCents: 91000, timezone: 'America/Chicago', state: 'IL', consent: false, attempts: [['blocked_by_compliance', 1]] },
      { externalRef: 'ATL-1004', name: 'Casey Dunn', phone: '+12125550114', balanceCents: 21000, timezone: NY, state: 'NY', consent: true, optedOut: true, attempts: [['opted_out', 4]] },
      { externalRef: 'ATL-1005', name: 'Taylor Ellis', phone: '+14155550115', balanceCents: 55000, timezone: LA, state: 'CA', consent: true, disputeOpen: true, attempts: [['dispute_raised', 3]] },
    ],
  },
  {
    slug: 'beacon-credit',
    name: 'Beacon Credit',
    debtors: [
      { externalRef: 'BCN-2001', name: 'Morgan Frost', phone: '+14155550201', balanceCents: 76000, timezone: LA, state: 'CA', consent: true, attempts: [['no_answer', 18]] },
      { externalRef: 'BCN-2002', name: 'Quinn Hale', phone: '+14155550202', balanceCents: 142000, timezone: LA, state: 'CA', consent: true, attempts: [['contacted', 25], ['no_answer', 16], ['voicemail_left', 5]] },
      { externalRef: 'BCN-2003', name: 'Avery Iverson', phone: '+12025550203', balanceCents: 9900, timezone: NY, state: 'DC', consent: true, optedOut: true, attempts: [['opted_out', 8]] },
    ],
  },
];

async function getAdminId(pool: Pool): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM app_user WHERE email = 'admin@demo.test'`);
  if (!rows[0]) throw new Error('admin@demo.test not found — run `npm run seed:users` first');
  return rows[0].id as string;
}

async function ensureLender(pool: Pool, slug: string, name: string, adminId: string): Promise<string> {
  const found = await pool.query('SELECT id FROM clinic WHERE slug = $1', [slug]);
  let id = found.rows[0]?.id as string | undefined;
  if (!id) {
    const r = await pool.query(
      `INSERT INTO clinic (slug, name, created_by_user_id) VALUES ($1,$2,$3) RETURNING id`,
      [slug, name, adminId],
    );
    id = r.rows[0].id as string;
  } else {
    await pool.query('UPDATE clinic SET name = $2 WHERE id = $1', [id, name]);
  }
  await pool.query(
    `INSERT INTO clinic_member (clinic_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [id, adminId],
  );
  return id;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DB });
  const store = new PgStore(pool);
  try {
    const adminId = await getAdminId(pool);
    const now = Date.now();
    for (const lender of LENDERS) {
      const clinicId = await ensureLender(pool, lender.slug, lender.name, adminId);
      // Fresh attempts each run so the dashboard is deterministic for the screenshot.
      await pool.query('DELETE FROM collections_call_attempt WHERE clinic_id = $1', [clinicId]);
      for (const d of lender.debtors) {
        const debtor = await store.upsertDebtor({
          clinicId, externalRef: d.externalRef, name: d.name, phone: d.phone,
          balanceCents: d.balanceCents, timezone: d.timezone, state: d.state,
          consent: d.consent ?? true, optedOut: d.optedOut ?? false, disputeOpen: d.disputeOpen ?? false,
        });
        for (const [outcome, daysAgo] of d.attempts ?? []) {
          await store.recordCallAttempt({
            clinicId, debtorId: debtor.id, debtorRef: debtor.externalRef, outcome,
            blockReason: outcome === 'blocked_by_compliance' ? 'no_consent' : null,
            blockReasons: outcome === 'blocked_by_compliance' ? ['no_consent'] : undefined,
            attemptedAtMs: now - daysAgo * DAY,
          });
        }
      }
      console.log(`  ✓ ${lender.name} (${lender.slug}) — ${lender.debtors.length} debtors, clinicId=${clinicId}`);
    }
    console.log('Seeded 2 demo lenders. Open /use-cases/call-center-agent/dashboard and switch lenders.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
