/**
 * SAU-333 (WS-2) — collections data layer against a REAL Postgres, as the NON-SUPERUSER
 * app_rw role (superusers/BYPASSRLS skip RLS, so the policies only truly bite here).
 *
 * Proves the WS-2 acceptance criteria:
 *   1. Per-lender tenant isolation — Lender A's debtor is invisible to Lender B
 *      (debtor leakage = fail); same-tenant + admin see it.
 *   2. PII at rest — the debtor `pii` column is an AES-256-GCM envelope (0 plaintext
 *      rows: name/phone/balance never readable in the column), and decrypts back
 *      through the store.
 *   3. Compliance audit ledger — writes through the store append HMAC-hash-chained
 *      rows; the chain verifies + detects tampering; the table is APPEND-ONLY:
 *      UPDATE/DELETE are rejected EVEN WITH app.is_admin='on' (tenant admin).
 *   4. Retention purge — disposes expired debtors; the audit ledger is RETAINED.
 *
 * Gated on DATABASE_URL + app_rw; self-skips under a bypass role. Self-cleaning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { PgStore } from '@/db/pg-store';
import { runWithActor } from '@/auth/actor';
import { verifyCollectionsAuditIntegrity } from '@/domain/collections-audit';
import { purgeExpiredDebtors } from '@/db/collections-retention-purge';

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

test('per-lender debtor isolation + PII at rest + append-only audit chain (non-superuser)', { skip }, async (t) => {
  const pool = new Pool({ connectionString: APP_RW });
  const owner = new Pool({ connectionString: DB });
  const probe = await pool.connect();
  if (await roleBypassesRls(probe)) { probe.release(); await pool.end(); await owner.end(); t.skip(BYPASS_SKIP); return; }
  probe.release();

  const store = new PgStore(pool);
  const stamp = Date.now();
  const ids: { lenderA?: string; lenderB?: string; debtorA?: string } = {};
  try {
    // Provision two lender tenants (reuse the clinic tenant primitive). Owner bypasses RLS.
    const a = await owner.query(`INSERT INTO clinic (slug, name) VALUES ($1,'Lender A') RETURNING id`, [`lender-a-${stamp}`]);
    const b = await owner.query(`INSERT INTO clinic (slug, name) VALUES ($1,'Lender B') RETURNING id`, [`lender-b-${stamp}`]);
    ids.lenderA = a.rows[0].id; ids.lenderB = b.rows[0].id;

    // Lender A ingests a synthetic debtor through the store (PII encrypted at the boundary).
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      const d = await store.upsertDebtor({
        clinicId: ids.lenderA!, externalRef: 'A-1', name: 'Jane Doe', phone: '+14155550123',
        balanceCents: 123456, timezone: 'America/Los_Angeles', state: 'CA', consent: true,
      });
      ids.debtorA = d.id;
      assert.equal(d.name, 'Jane Doe', 'PII round-trips through the store');
      assert.equal(d.balanceCents, 123456);
    });

    // ── PII AT REST: the `pii` column is an {_enc} envelope — 0 plaintext rows ──
    const raw = await owner.query('SELECT pii::text AS pii FROM debtor WHERE id = $1', [ids.debtorA]);
    const piiText: string = raw.rows[0].pii;
    assert.ok(piiText.includes('_enc'), 'pii is stored as an encryption envelope');
    assert.ok(!/Jane Doe/.test(piiText), 'debtor NAME never appears in the column at rest');
    assert.ok(!/14155550123/.test(piiText), 'debtor PHONE never appears in the column at rest');
    assert.ok(!/123456/.test(piiText), 'debtor BALANCE never appears in the column at rest');
    const plaintextCount = await owner.query(
      `SELECT count(*)::int AS n FROM debtor WHERE clinic_id = ANY($1) AND NOT (pii ? '_enc')`,
      [[ids.lenderA, ids.lenderB]],
    );
    assert.equal(plaintextCount.rows[0].n, 0, '0 debtor rows store plaintext PII');

    // ── TENANT ISOLATION: Lender B cannot see Lender A's debtor ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      const got = await store.getDebtor(ids.debtorA!);
      assert.equal(got, null, "Lender B must not read Lender A's debtor (no leakage)");
      const list = await store.listDebtorsForClinic(ids.lenderA!);
      assert.equal(list.length, 0, "Lender B's scoped list never includes Lender A's debtors");
    });
    // Same-tenant DOES see it.
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      const list = await store.listDebtorsForClinic(ids.lenderA!);
      assert.equal(list.length, 1, 'Lender A reads its own debtor');
    });

    // ── COMPLIANCE LEDGER: a dial decision + opt-out append HMAC-chained rows ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderA! }, async () => {
      await store.recordCollectionsAudit({
        clinicId: ids.lenderA!, debtorRef: ids.debtorA!, eventType: 'dial_decision',
        decision: 'BLOCK', reason: 'outside_window', refs: { hourLocal: 20 },
      });
      await store.setDebtorOptOut(ids.debtorA!, true); // writes an 'opt_out' audit row

      const log = await store.listCollectionsAudit({ clinicId: ids.lenderA!, debtorRef: ids.debtorA! });
      assert.equal(log.length, 2, 'both the dial decision and the opt-out are logged');
      // Newest first → [opt_out, dial_decision]. The opt_out row chains onto the dial row.
      const [optOut, dial] = log;
      assert.equal(dial.eventType, 'dial_decision');
      assert.equal(dial.decision, 'BLOCK');
      assert.equal(optOut.eventType, 'opt_out');
      assert.equal(optOut.prevIntegrity, dial.integrity, 'opt-out row commits to the prior row (hash chain)');

      // Tamper-evidence: each row's tag verifies over its content + prev link.
      for (const r of log) {
        const ok = verifyCollectionsAuditIntegrity(
          { ts: r.ts, clinicId: r.clinicId, actorUserId: r.actorUserId, actorLabel: r.actorLabel,
            debtorRef: r.debtorRef, eventType: r.eventType, decision: r.decision, reason: r.reason, refs: r.refs },
          r.prevIntegrity, r.integrity,
        );
        assert.ok(ok, `audit row ${r.seq} integrity verifies`);
      }
    });

    // ── Lender B cannot read Lender A's ledger rows ──
    await runWithActor({ userId: '', isAdmin: false, clinicId: ids.lenderB! }, async () => {
      const log = await store.listCollectionsAudit({ clinicId: ids.lenderA! });
      assert.equal(log.length, 0, "Lender B must not read Lender A's compliance ledger");
    });

    // ── APPEND-ONLY: UPDATE/DELETE rejected EVEN AS TENANT ADMIN (is_admin='on') ──
    // Session-level GUCs (not tx-local) so each failing statement runs as its own
    // implicit transaction — a rejection can't poison the next assertion.
    const adminClient = await pool.connect();
    try {
      await adminClient.query("SELECT set_config('app.is_admin','on',false), set_config('app.clinic_id',$1,false)", [ids.lenderA]);
      await assert.rejects(
        adminClient.query(`UPDATE collections_audit_log SET reason = 'forged' WHERE clinic_id = $1`, [ids.lenderA]),
        /append-only|permission denied/i,
        'UPDATE on the ledger is rejected even for a tenant admin',
      );
      await assert.rejects(
        adminClient.query(`DELETE FROM collections_audit_log WHERE clinic_id = $1`, [ids.lenderA]),
        /append-only|permission denied/i,
        'DELETE on the ledger is rejected even for a tenant admin',
      );
    } finally {
      adminClient.release();
    }

    // ── RETENTION PURGE: disposes an aged debtor; the ledger is RETAINED ──
    // Age Lender A's debtor past the window (backdate created_at as owner).
    await owner.query(`UPDATE debtor SET created_at = now() - interval '400 days' WHERE id = $1`, [ids.debtorA]);
    const ledgerBefore = await owner.query('SELECT count(*)::int AS n FROM collections_audit_log WHERE clinic_id = $1', [ids.lenderA]);
    const report = await purgeExpiredDebtors(pool, {});
    const gone = await owner.query('SELECT 1 FROM debtor WHERE id = $1', [ids.debtorA]);
    assert.equal(gone.rowCount, 0, 'aged debtor is disposed by the purge');
    assert.ok(report.debtorsPurged >= 1, 'purge reports at least one disposed debtor');
    const ledgerAfter = await owner.query('SELECT count(*)::int AS n FROM collections_audit_log WHERE clinic_id = $1', [ids.lenderA]);
    // Ledger retained + one 'purge' row appended (never deleted).
    assert.ok(ledgerAfter.rows[0].n > ledgerBefore.rows[0].n, 'a purge audit row was appended; ledger is retained, never deleted');
  } finally {
    await owner.query('DELETE FROM clinic WHERE id = ANY($1)', [[ids.lenderA, ids.lenderB]]).catch(() => {});
    await owner.end();
    await pool.end();
  }
});
