/**
 * PHI retention auto-deletion (SAU-285, Phase 1 · WS5) — the eng enforcement of
 * the program-doc §4 disposal policy; gate item 11 of the HIPAA go-live gate
 * (SAU-272). Two layers, mirroring phi-encryption.test.ts:
 *
 *  1. Pure unit tests (no DB, always run): window resolution — platform defaults,
 *     per-clinic override, partial override merge, and rejection of junk values.
 *
 *  2. A DATABASE_URL-gated regression (skipped in the in-memory CI run): with a
 *     past-window and a recent clinic record on disk, one purge run crypto-shreds
 *     the expired transcript, deletes the expired event payloads + intake outcome,
 *     LEAVES the recent records and a per-clinic-override clinic untouched, RETAINS
 *     phi_access_log, audit-logs the disposal as append-only 'purge' rows, and is
 *     idempotent on a second run. A dry-run reports the same counts but writes
 *     nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { resolveClinicWindows, DEFAULT_RETENTION } from '@/services/retention-policy';
import { purgeExpiredPhi } from '@/db/retention-purge';

// ── Layer 1: pure unit tests (no DB) ─────────────────────────────────────────

test('resolveClinicWindows: no override → platform defaults', () => {
  assert.deepEqual(resolveClinicWindows(null), DEFAULT_RETENTION);
  assert.deepEqual(resolveClinicWindows(undefined), DEFAULT_RETENTION);
  assert.deepEqual(resolveClinicWindows({}), DEFAULT_RETENTION);
});

test('resolveClinicWindows: per-clinic override wins per field, others default', () => {
  const w = resolveClinicWindows({ transcriptDays: 7 });
  assert.equal(w.transcriptDays, 7, 'override applied');
  assert.equal(w.intakeDays, DEFAULT_RETENTION.intakeDays, 'unspecified field keeps default');
  const both = resolveClinicWindows({ transcriptDays: 14, intakeDays: 730 });
  assert.deepEqual({ t: both.transcriptDays, i: both.intakeDays }, { t: 14, i: 730 });
});

test('resolveClinicWindows: junk/zero/negative values fall back to defaults', () => {
  const w = resolveClinicWindows({ transcriptDays: 0, intakeDays: -5 });
  assert.equal(w.transcriptDays, DEFAULT_RETENTION.transcriptDays);
  assert.equal(w.intakeDays, DEFAULT_RETENTION.intakeDays);
  const s = resolveClinicWindows({ transcriptDays: 'soon', intakeDays: null } as unknown);
  assert.equal(s.transcriptDays, DEFAULT_RETENTION.transcriptDays);
  assert.equal(s.intakeDays, DEFAULT_RETENTION.intakeDays);
});

test('default windows are the program-doc §4 policy (30d / 365d / 6y) absent env overrides', () => {
  // The CI process sets no PHI_RETENTION_* env, so defaults are the policy floor.
  assert.equal(DEFAULT_RETENTION.transcriptDays, 30);
  assert.equal(DEFAULT_RETENTION.intakeDays, 365);
  assert.equal(DEFAULT_RETENTION.auditLogYears, 6);
});

// ── Layer 2: DATABASE_URL-gated regression (real Postgres) ───────────────────
const DB = process.env.DATABASE_URL;
const skip = DB ? false : 'no DATABASE_URL — needs a migrated Postgres (run via npm run migrate)';
const DAY_MS = 24 * 60 * 60 * 1000;

test('purge: past-window PHI is disposed, recent + override-clinic retained, audit-logged, idempotent', { skip }, async () => {
  const pool = new Pool({ connectionString: DB });
  const stamp = Date.now();
  const now = new Date();
  const old = new Date(now.getTime() - 400 * DAY_MS); // past both 30d and 365d windows
  const recent = new Date(now.getTime() - 1 * DAY_MS); // inside both windows
  const ids: Record<string, string> = {};
  try {
    // Two clinics: default windows, and one with a long per-clinic override.
    const c1 = await pool.query(`INSERT INTO clinic (slug, name) VALUES ($1,'Default') RETURNING id`, [`ret-c1-${stamp}`]);
    const c2 = await pool.query(
      `INSERT INTO clinic (slug, name, retention) VALUES ($1,'LongHold','{"transcriptDays":9999,"intakeDays":9999}'::jsonb) RETURNING id`,
      [`ret-c2-${stamp}`],
    );
    ids.c1 = c1.rows[0].id; ids.c2 = c2.rows[0].id;
    const sc = await pool.query(
      `INSERT INTO scenario (slug, name, ai_instructions, is_public) VALUES ($1,'clinic','x',true) RETURNING id`,
      [`ret-scn-${stamp}`],
    );
    ids.scenario = sc.rows[0].id;

    // Seed a clinic session with transcript + event + intake at a given age/clinic.
    const seed = async (clinicId: string, when: Date): Promise<string> => {
      const s = await pool.query(
        `INSERT INTO session (clinic_id, scenario_id, vendor, status, started_at, ended_at, transcript, recording_uri)
         VALUES ($1,$2,'mock','completed',$3,$3,'{"_enc":"iv:ct:tag"}'::jsonb,'rec://blob') RETURNING id`,
        [clinicId, ids.scenario, when],
      );
      const sid = s.rows[0].id;
      await pool.query(
        `INSERT INTO session_event (session_id, ts, type, payload) VALUES ($1,$2,'transcript','{"_enc":"iv:ct:tag"}'::jsonb)`,
        [sid, when],
      );
      await pool.query(
        `INSERT INTO clinic_session_outcome (session_id, scenario_id, clinic_id, outcome, intake, created_at)
         VALUES ($1,$2,$3,'booked','{"_enc":"iv:ct:tag"}'::jsonb,$4)`,
        [sid, ids.scenario, clinicId, when],
      );
      return sid;
    };
    ids.sOld = await seed(ids.c1, old);       // default clinic, expired → disposed
    ids.sRecent = await seed(ids.c1, recent); // default clinic, fresh → retained
    ids.sHold = await seed(ids.c2, old);      // long-override clinic, old → retained

    const logBefore = (await pool.query('SELECT count(*)::int AS n FROM phi_access_log')).rows[0].n as number;

    // ── dry-run first: reports the disposal but changes nothing ──────────────
    const dry = await purgeExpiredPhi(pool, { now, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.transcriptsShredded, 1, 'dry-run counts the one expired transcript');
    assert.equal(dry.intakeRecordsPurged, 1, 'dry-run counts the one expired intake');
    assert.ok(dry.sessionEventsDeleted >= 1, 'dry-run counts expired event payloads');
    // nothing actually changed:
    const stillThere = await pool.query('SELECT transcript FROM session WHERE id = $1', [ids.sOld]);
    assert.notEqual(stillThere.rows[0].transcript, null, 'dry-run did NOT shred the transcript');
    const logAfterDry = (await pool.query('SELECT count(*)::int AS n FROM phi_access_log')).rows[0].n as number;
    assert.equal(logAfterDry, logBefore, 'dry-run wrote no audit rows');

    // ── real run ─────────────────────────────────────────────────────────────
    const r = await purgeExpiredPhi(pool, { now });
    assert.equal(r.transcriptsShredded, 1, 'one expired transcript shredded');
    assert.equal(r.intakeRecordsPurged, 1, 'one expired intake purged');
    assert.ok(r.sessionEventsDeleted >= 1, 'expired event payloads deleted');

    // expired (default-clinic) row is crypto-shredded / deleted:
    const oldSession = await pool.query('SELECT transcript, recording_uri FROM session WHERE id = $1', [ids.sOld]);
    assert.equal(oldSession.rows[0].transcript, null, 'expired transcript column nulled (crypto-shred)');
    assert.equal(oldSession.rows[0].recording_uri, null, 'expired audio pointer nulled');
    const oldEvents = await pool.query('SELECT count(*)::int AS n FROM session_event WHERE session_id = $1', [ids.sOld]);
    assert.equal(oldEvents.rows[0].n, 0, 'expired event payloads gone');
    const oldOutcome = await pool.query('SELECT count(*)::int AS n FROM clinic_session_outcome WHERE session_id = $1', [ids.sOld]);
    assert.equal(oldOutcome.rows[0].n, 0, 'expired intake outcome gone');

    // recent (default-clinic) row is untouched:
    const recentSession = await pool.query('SELECT transcript FROM session WHERE id = $1', [ids.sRecent]);
    assert.notEqual(recentSession.rows[0].transcript, null, 'recent transcript retained');
    const recentOutcome = await pool.query('SELECT count(*)::int AS n FROM clinic_session_outcome WHERE session_id = $1', [ids.sRecent]);
    assert.equal(recentOutcome.rows[0].n, 1, 'recent intake retained');

    // long-override clinic: old, but its BAA window keeps it:
    const holdSession = await pool.query('SELECT transcript FROM session WHERE id = $1', [ids.sHold]);
    assert.notEqual(holdSession.rows[0].transcript, null, 'per-clinic override retains an old transcript');
    const holdOutcome = await pool.query('SELECT count(*)::int AS n FROM clinic_session_outcome WHERE session_id = $1', [ids.sHold]);
    assert.equal(holdOutcome.rows[0].n, 1, 'per-clinic override retains an old intake');

    // phi_access_log: RETAINED (never purged) + the disposal is audit-logged as 'purge'.
    const logAfter = (await pool.query('SELECT count(*)::int AS n FROM phi_access_log')).rows[0].n as number;
    assert.ok(logAfter > logBefore, 'phi_access_log grew (purge rows appended), none deleted');
    const purgeRows = await pool.query(
      `SELECT entity FROM phi_access_log WHERE action = 'purge' AND entity_id = $1 ORDER BY entity`,
      [ids.sOld],
    );
    const entities = purgeRows.rows.map((x) => x.entity);
    assert.ok(entities.includes('session.transcript'), 'transcript disposal logged');
    assert.ok(entities.includes('clinic_session_outcome.intake'), 'intake disposal logged');

    // ── idempotent: a second run disposes nothing more ──────────────────────
    const r2 = await purgeExpiredPhi(pool, { now });
    assert.equal(r2.transcriptsShredded, 0, 'nothing left to shred on re-run');
    assert.equal(r2.intakeRecordsPurged, 0, 'nothing left to purge on re-run');
    assert.equal(r2.sessionEventsDeleted, 0, 'no event payloads left on re-run');
  } finally {
    // Cleanup: delete sessions (cascades to events + outcomes); clinics + scenario.
    // phi_access_log 'purge' rows are intentionally LEFT — the table is append-only
    // by design and each run's entity_ids are unique, so leftovers never affect re-runs.
    for (const k of ['sOld', 'sRecent', 'sHold']) {
      if (ids[k]) await pool.query('DELETE FROM session WHERE id = $1', [ids[k]]);
    }
    if (ids.scenario) await pool.query('DELETE FROM scenario WHERE id = $1', [ids.scenario]);
    if (ids.c1) await pool.query('DELETE FROM clinic WHERE id = $1', [ids.c1]);
    if (ids.c2) await pool.query('DELETE FROM clinic WHERE id = $1', [ids.c2]);
    await pool.end();
  }
});
