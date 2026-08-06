/**
 * SAU-335 (WS-4) — per-tenant collections ops dashboard against a REAL Postgres, as the
 * NON-SUPERUSER app_rw role (superusers/BYPASSRLS skip RLS, so the policies only truly
 * bite here). The collections analogue of SAU-301's Northgate/Riverside isolation proof.
 *
 * Proves the WS-4 acceptance criteria that need real RLS:
 *   1. Per-lender dashboard isolation — Lender A's dashboard reflects ONLY A's debtors,
 *      attempts and audit rows; Lender B sees ONLY its own (no cross-tenant leakage).
 *   2. Call-attempt outcomes persist + mirror into the append-only compliance ledger
 *      (a blocked dial → dial_decision BLOCK; a placed call → call_outcome).
 *   3. "Next eligible dial" is the engine's verdict over the SAME placed-attempt history.
 *
 * Gated on DATABASE_URL + app_rw; self-skips under a bypass role. Self-cleaning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { PgStore } from '@/db/pg-store';
import { runWithActor } from '@/auth/actor';
import { getCollectionsDashboard } from '@/services/collections-dashboard';

const DB = process.env.DATABASE_URL;
const APP_RW =
  process.env.APP_RW_DATABASE_URL ?? (DB ? DB.replace(/\/\/[^@]+@/, '//app_rw:app_rw@') : undefined);
const skip = APP_RW ? false : 'no DATABASE_URL/APP_RW_DATABASE_URL — needs a migrated Postgres + app_rw role';

async function roleBypassesRls(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user',
  );
  return Boolean(rows[0]?.bypass);
}
const BYPASS_SKIP = 'connection role bypasses RLS (superuser / BYPASSRLS) — policies are inert; run as app_rw.';

const DAY = 86_400_000;
// A deterministic in-window working-day "now" so cadence math is stable across runs.
const NOW = Date.parse('2026-06-17T14:00:00-04:00');

test('per-lender dashboard isolation + outcome persistence + next-eligible dial (non-superuser)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: APP_RW });
  const owner = new Pool({ connectionString: DB });
  const probe = await pool.connect();
  if (await roleBypassesRls(probe)) { probe.release(); await pool.end(); await owner.end(); t.skip(BYPASS_SKIP); return; }
  probe.release();

  const store = new PgStore(pool);
  const stamp = Date.now();
  const ids: { lenderA?: string; lenderB?: string; okA?: string; optA?: string; nocA?: string } = {};
  try {
    // Two lender tenants (reuse the clinic primitive). Owner bypasses RLS for setup.
    const a = await owner.query(`INSERT INTO clinic (slug, name) VALUES ($1,'Lender A') RETURNING id`, [`dash-a-${stamp}`]);
    const b = await owner.query(`INSERT INTO clinic (slug, name) VALUES ($1,'Lender B') RETURNING id`, [`dash-b-${stamp}`]);
    ids.lenderA = a.rows[0].id; ids.lenderB = b.rows[0].id;

    // ── Lender A: 3 debtors + attempts (one placed, one opted-out, one blocked) ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      // SAU-521 AC 3: configure the tenant's licensing policy in the STORE. The dashboard
      // is then called with NO explicit config below, so this test also proves it LOADS
      // the persisted policy — before SAU-521 it silently defaulted to `{}` and reported
      // "next eligible" under a policy the dialer was not using.
      await store.upsertCollectionsPolicy({ clinicId: ids.lenderA!, allowedStates: ['NY'] });

      const ok = await store.upsertDebtor({
        clinicId: ids.lenderA!, externalRef: 'A-OK', name: 'Ann Able', phone: '+12125550101',
        balanceCents: 5000, timezone: 'America/New_York', state: 'NY', consent: true,
      });
      const opt = await store.upsertDebtor({
        clinicId: ids.lenderA!, externalRef: 'A-OPT', name: 'Ben Bly', phone: '+12125550102',
        balanceCents: 6000, timezone: 'America/New_York', state: 'NY', consent: true, optedOut: true,
      });
      const noc = await store.upsertDebtor({
        clinicId: ids.lenderA!, externalRef: 'A-NOC', name: 'Cara Cole', phone: '+12125550103',
        balanceCents: 7000, timezone: 'America/New_York', state: 'NY', consent: false,
      });
      ids.okA = ok.id; ids.optA = opt.id; ids.nocA = noc.id;

      await store.recordCallAttempt({ clinicId: ids.lenderA!, debtorId: ok.id, debtorRef: ok.externalRef, outcome: 'contacted', attemptedAtMs: NOW - 40 * DAY });
      await store.recordCallAttempt({ clinicId: ids.lenderA!, debtorId: opt.id, debtorRef: opt.externalRef, outcome: 'opted_out', attemptedAtMs: NOW - 5 * DAY });
      await store.recordCallAttempt({ clinicId: ids.lenderA!, debtorId: noc.id, debtorRef: noc.externalRef, outcome: 'blocked_by_compliance', blockReason: 'no_consent', blockReasons: ['no_consent'], attemptedAtMs: NOW - 1 * DAY });
    });

    // ── Lender B: one unrelated debtor + attempt ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      await store.upsertCollectionsPolicy({ clinicId: ids.lenderB!, allowedStates: ['CA'] });

      const d = await store.upsertDebtor({
        clinicId: ids.lenderB!, externalRef: 'B-1', name: 'Dave Dunn', phone: '+14155550201',
        balanceCents: 8000, timezone: 'America/Los_Angeles', state: 'CA', consent: true,
      });
      await store.recordCallAttempt({ clinicId: ids.lenderB!, debtorId: d.id, debtorRef: d.externalRef, outcome: 'no_answer', attemptedAtMs: NOW - 18 * DAY });
    });

    // ── Lender A's dashboard: only A's data, correct aggregates + next-eligible dial ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      const m = await getCollectionsDashboard(store, ids.lenderA!, NOW);
      assert.equal(m.totalDebtors, 3, "A sees exactly its 3 debtors");
      assert.equal(m.eligibleNow, 1, 'only the healthy, cadence-elapsed debtor is eligible now');
      assert.equal(m.suppressed, 1, 'the opted-out debtor is on the suppression list');
      assert.equal(m.totalAttempts, 2, 'placed attempts exclude the compliance block');
      assert.equal(m.blockedAttempts, 1);
      assert.equal(m.outcomes.contacted, 1);
      assert.equal(m.outcomes.opted_out, 1);
      assert.deepEqual(m.complianceBlocks, [{ reason: 'no_consent', count: 1 }], 'block mirrored into the ledger by reason');

      const okRow = m.cadence.find((c) => c.externalRef === 'A-OK')!;
      assert.equal(okRow.allowedNow, true, 'A-OK eligible now (40d-old contact > cadence)');
      const optRow = m.cadence.find((c) => c.externalRef === 'A-OPT')!;
      assert.equal(optRow.permanentBlock, true);
      assert.equal(optRow.nextEligibleAt, null, 'no fabricated date for a suppressed debtor');
    });

    // ── Lender B's dashboard: only B's data — zero leakage of A's debtors/attempts ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      const m = await getCollectionsDashboard(store, ids.lenderB!, NOW);
      assert.equal(m.totalDebtors, 1, "B sees ONLY its own debtor (no leakage of A's 3)");
      assert.equal(m.totalAttempts, 1);
      assert.equal(m.outcomes.no_answer, 1);
      assert.equal(m.complianceBlocks.length, 0, "B has no blocks; it cannot see A's");
      assert.ok(!m.cadence.some((c) => c.externalRef.startsWith('A-')), "none of A's debtors appear on B's dashboard");
    });

    // ── Attempts are themselves RLS-scoped: B cannot read A's attempt rows ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      const aAttempts = await store.listCallAttemptsForClinic(ids.lenderA!);
      assert.equal(aAttempts.length, 0, "B's scoped query never returns A's attempts");
    });
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      const aAttempts = await store.listCallAttemptsForClinic(ids.lenderA!);
      assert.equal(aAttempts.length, 3, 'A reads its own 3 attempts (incl. the block)');
    });
  } finally {
    await owner.query('DELETE FROM clinic WHERE id = ANY($1)', [[ids.lenderA, ids.lenderB]]).catch(() => {});
    await owner.end();
    await pool.end();
  }
});
