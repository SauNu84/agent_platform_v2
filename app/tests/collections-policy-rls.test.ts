/**
 * SAU-521 — per-lender collections policy against a REAL Postgres, as the NON-SUPERUSER
 * `app_rw` role (superusers / BYPASSRLS skip RLS entirely, so the policies only truly
 * bite here — a run under the owner proves nothing).
 *
 * Proves the SAU-521 acceptance criteria that need real infrastructure:
 *   AC 1/5 — the policy PERSISTS and round-trips per tenant.
 *   AC 5   — Tenant A's policy cannot be READ or WRITTEN by Tenant B (the whole point
 *            of putting this under the existing lender RLS policy rather than inventing
 *            a new scoping model), and `debtor`'s own isolation is not weakened by it.
 *   AC 4a  — the go-live preflight fails for an unconfigured tenant and passes once the
 *            allow-list is set — through the store, not a stub.
 *   AC 4b  — the ENGINE blocks an unconfigured tenant even when everything else about
 *            the debtor is healthy, and that verdict is reached through the loader.
 *
 * Gated on DATABASE_URL + app_rw; self-skips under a bypass role. Self-cleaning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { PgStore } from '@/db/pg-store';
import { runWithActor } from '@/auth/actor';
import { canDialNow } from '@/domain/collections-engine';
import {
  loadTenantCollectionsConfig,
  preflightCollectionsGoLive,
  assertCollectionsGoLiveReady,
  saveTenantCollectionsPolicy,
  CollectionsPolicyError,
} from '@/services/collections-policy';

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
const BYPASS_SKIP =
  'connection role bypasses RLS (superuser / BYPASSRLS) — policies are inert; run as app_rw.';

/** A debtor that passes every OTHER gate, so only the licensing verdict varies. */
const healthyDebtor = (state: string | null) => ({
  timezone: 'America/New_York',
  phone: '+12125550100',
  state,
  consent: true,
  optedOut: false,
  disputeOpen: false,
});
// Wed 2026-06-17 14:00 ET — working day, inside the 9–5 window, not a holiday.
const WED_2PM_ET = Date.parse('2026-06-17T14:00:00-04:00');

test('collections policy: per-lender persistence + RLS isolation + fail-closed (non-superuser)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: APP_RW });
  const owner = new Pool({ connectionString: DB });
  const probe = await pool.connect();
  if (await roleBypassesRls(probe)) { probe.release(); await pool.end(); await owner.end(); t.skip(BYPASS_SKIP); return; }
  probe.release();

  const store = new PgStore(pool);
  const stamp = Date.now();
  const ids: { lenderA?: string; lenderB?: string } = {};
  try {
    const a = await owner.query(`INSERT INTO clinic (slug, name) VALUES ($1,'Lender A') RETURNING id`, [`pol-a-${stamp}`]);
    const b = await owner.query(`INSERT INTO clinic (slug, name) VALUES ($1,'Lender B') RETURNING id`, [`pol-b-${stamp}`]);
    ids.lenderA = a.rows[0].id; ids.lenderB = b.rows[0].id;

    // ── AC 4a/4b: BEFORE configuration, the tenant is not cleared to dial ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      const pre = await preflightCollectionsGoLive(store, ids.lenderA!);
      assert.equal(pre.ok, false, 'an unconfigured tenant must FAIL the go-live preflight');
      assert.equal(pre.failures[0]?.code, 'licensing_unconfigured');
      assert.match(pre.failures[0]?.message ?? '', /allowedStates/, 'the failure names the remediation');
      await assert.rejects(
        () => assertCollectionsGoLiveReady(store, ids.lenderA!),
        (err: unknown) => err instanceof CollectionsPolicyError && err.status === 409,
      );

      // The ENGINE agrees, via the loader — a healthy debtor in a real state is blocked.
      const cfg = await loadTenantCollectionsConfig(store, ids.lenderA!);
      assert.deepEqual(cfg.allowedStates, [], 'no row ⇒ empty allow-list, never a default');
      const verdict = canDialNow(healthyDebtor('NY'), WED_2PM_ET, { config: cfg });
      assert.equal(verdict.decision, 'BLOCK');
      assert.ok(verdict.reasons.some((r) => r.code === 'licensing_unconfigured'));
    });

    // ── AC 1: the policy persists and round-trips for its own tenant ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      // Written through the service so normalisation is exercised too: lowercase input,
      // a duplicate, and an unsorted list must all come back canonical.
      await saveTenantCollectionsPolicy(store, ids.lenderA!, {
        allowedStates: ['ny', 'CA', 'ny'],
        stateCaps: { ma: { maxAttempts: 2, windowDays: 7 } },
      });
      const stored = await store.getCollectionsPolicy(ids.lenderA!);
      assert.deepEqual(stored?.allowedStates, ['CA', 'NY'], 'uppercased, deduped, sorted');
      assert.deepEqual(stored?.stateCaps, { MA: { maxAttempts: 2, windowDays: 7 } }, 'cap keys uppercased');

      // AC 4a now passes for this tenant.
      const pre = await preflightCollectionsGoLive(store, ids.lenderA!);
      assert.equal(pre.ok, true, 'a configured tenant passes the preflight');

      // And the engine now permits an in-list debtor while still excluding others.
      const cfg = await loadTenantCollectionsConfig(store, ids.lenderA!);
      assert.equal(canDialNow(healthyDebtor('NY'), WED_2PM_ET, { config: cfg }).decision, 'ALLOW');
      const tx = canDialNow(healthyDebtor('TX'), WED_2PM_ET, { config: cfg });
      assert.equal(tx.decision, 'BLOCK');
      assert.ok(tx.reasons.some((r) => r.code === 'state_not_licensed'), 'out-of-list ≠ unconfigured');
      const unknown = canDialNow(healthyDebtor(null), WED_2PM_ET, { config: cfg });
      assert.ok(unknown.reasons.some((r) => r.code === 'state_not_licensed'), 'null state is default-denied');
    });

    // ── AC 5: Lender B cannot READ Lender A's policy ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      const leaked = await store.getCollectionsPolicy(ids.lenderA!);
      assert.equal(leaked, null, "Lender B must not read Lender A's policy");

      // B's own tenant is still unconfigured — A's configuration must not leak across
      // as an effective policy either.
      const cfg = await loadTenantCollectionsConfig(store, ids.lenderB!);
      assert.deepEqual(cfg.allowedStates, []);
      const pre = await preflightCollectionsGoLive(store, ids.lenderB!);
      assert.equal(pre.ok, false, "Lender A's allow-list must not clear Lender B for go-live");
    });

    // ── AC 5: Lender B cannot WRITE Lender A's policy ──
    // The RLS WITH CHECK rejects the row outright; whichever way it surfaces (an error,
    // or a silently-unaffected write), Lender A's stored policy must be unchanged.
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      await store.upsertCollectionsPolicy({ clinicId: ids.lenderA!, allowedStates: ['TX'] }).catch(() => undefined);
    });
    const afterCrossWrite = await owner.query(
      'SELECT allowed_states FROM collections_policy WHERE clinic_id = $1', [ids.lenderA],
    );
    assert.deepEqual(
      afterCrossWrite.rows[0]?.allowed_states, ['CA', 'NY'],
      "Lender B must not be able to overwrite Lender A's licensing allow-list",
    );

    // ── AC 4b: clearing the allow-list re-blocks the tenant (the continuous invariant
    // a point-in-time preflight cannot hold). This is the exact post-onboarding
    // regression the engine check exists for.
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      await saveTenantCollectionsPolicy(store, ids.lenderA!, { allowedStates: [] });
      const cfg = await loadTenantCollectionsConfig(store, ids.lenderA!);
      const verdict = canDialNow(healthyDebtor('NY'), WED_2PM_ET, { config: cfg });
      assert.equal(verdict.decision, 'BLOCK', 'a cleared allow-list must stop the tenant again');
      assert.ok(verdict.reasons.some((r) => r.code === 'licensing_unconfigured'));
    });

    // ── Partial update must not clobber the allow-list (the wipe-by-accident path) ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      await saveTenantCollectionsPolicy(store, ids.lenderA!, { allowedStates: ['NY'] });
      await saveTenantCollectionsPolicy(store, ids.lenderA!, { stateCaps: { NY: { maxAttempts: 1, windowDays: 7 } } });
      const stored = await store.getCollectionsPolicy(ids.lenderA!);
      assert.deepEqual(stored?.allowedStates, ['NY'], 'a caps-only edit must not clear the allow-list');
    });

    // ── The debtor table's own isolation is untouched by this migration ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      await store.upsertDebtor({
        clinicId: ids.lenderA!, externalRef: 'POL-1', name: 'Jane Doe', phone: '+14155550123',
        balanceCents: 1000, timezone: 'America/New_York', state: 'NY', consent: true,
      });
    });
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      const seen = await store.listDebtorsForClinic(ids.lenderA!);
      assert.equal(seen.length, 0, "debtor isolation must still hold after 0026");
    });

    // ── Storage-layer shape guard: a hand-written bad code is rejected by CHECK ──
    await assert.rejects(
      () => owner.query(
        `INSERT INTO collections_policy (clinic_id, allowed_states) VALUES ($1, $2)
         ON CONFLICT (clinic_id) DO UPDATE SET allowed_states = EXCLUDED.allowed_states`,
        [ids.lenderB, ['California']],
      ),
      'a non-2-letter state code must be rejected at the storage layer',
    );
  } finally {
    // clinic ON DELETE CASCADE removes the policy + debtor rows with the tenants.
    for (const id of [ids.lenderA, ids.lenderB]) {
      if (id) await owner.query('DELETE FROM clinic WHERE id = $1', [id]).catch(() => undefined);
    }
    await pool.end();
    await owner.end();
  }
});
