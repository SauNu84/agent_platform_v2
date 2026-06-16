/**
 * SAU-301 WS-B — seed two isolated demo clinics + synthetic outcomes for the ops
 * dashboard live-verify + screenshot. Run against the dev DB as the superuser/owner
 * role (RLS bypassed for seeding, like seed-cli's admin actor):
 *   DATABASE_URL=postgres://agent:agent@localhost:5433/agent_platform node scripts/seed-wsb-demo.mjs
 * Idempotent on the clinic slugs. Synthetic/test data only.
 */
import pg from 'pg';

const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const NY = 'America/New_York';
const HOURS = [null, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 1020 }, { openMin: 540, closeMin: 960 }, null];
function cfg(name) {
  return {
    name, timezone: NY,
    hours: HOURS.map((d) => (d ? { open: '09:00', close: d.closeMin === 960 ? '16:00' : '17:00' } : null)),
    slotMinutes: 30,
    doctors: [{ id: 'dr-1', name: 'Dr. Lee', specialty: 'Family', serviceIds: [] }],
    services: [{ id: 'svc-1', name: 'New patient', durationMinutes: 30 }],
    insuranceAccepted: ['Aetna', 'BlueCross'],
    afterHours: { mode: 'voicemail' },
    bufferMinutes: 0, leadTimeMinutes: 0, maxPerDay: 0, greeting: '',
  };
}

async function getAdmin() {
  const { rows } = await p.query(`SELECT id FROM app_user WHERE email = 'admin@demo.test'`);
  if (!rows[0]) throw new Error('admin@demo.test not found — run npm run seed:users first');
  return rows[0].id;
}

async function ensureClinic(slug, name, adminId, config) {
  const found = await p.query('SELECT id FROM clinic WHERE slug = $1', [slug]);
  let id = found.rows[0]?.id;
  if (!id) {
    const r = await p.query(
      `INSERT INTO clinic (slug, name, created_by_user_id, config) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
      [slug, name, adminId, JSON.stringify(config)],
    );
    id = r.rows[0].id;
  } else {
    await p.query('UPDATE clinic SET config = $2::jsonb, name = $3 WHERE id = $1', [id, JSON.stringify(config), name]);
  }
  await p.query(`INSERT INTO clinic_member (clinic_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`, [id, adminId]);
  return id;
}

async function scenarioId() {
  const r = await p.query(`SELECT id FROM scenario WHERE slug LIKE 'clinic%' OR name ILIKE '%clinic%' LIMIT 1`);
  if (r.rows[0]) return r.rows[0].id;
  const ins = await p.query(`INSERT INTO scenario (slug, name, ai_instructions, is_public) VALUES ('wsb-demo-clinic','Clinic demo','x',true) RETURNING id`);
  return ins.rows[0].id;
}

// outcome spec: [outcome, hasEvent, afterHours, escalationReason, handoff, confirm]
async function seedOutcomes(clinicId, adminId, scnId, specs) {
  // clear previous synthetic rows for this clinic (re-runnable)
  await p.query(`DELETE FROM clinic_session_outcome WHERE clinic_id = $1`, [clinicId]);
  for (let i = 0; i < specs.length; i++) {
    const [outcome, hasEvent, afterHours, reason, handoff, confirm] = specs[i];
    const s = await p.query(
      `INSERT INTO session (scenario_id, user_id, clinic_id, vendor, status, started_at)
       VALUES ($1,$2,$3,'mock','completed', now() - ($4 || ' hours')::interval) RETURNING id`,
      [scnId, adminId, clinicId, String(i)],
    );
    const start = `now() + '${i + 1} days'`;
    await p.query(
      `INSERT INTO clinic_session_outcome
         (session_id, scenario_id, user_id, clinic_id, outcome, event_id, doctor_name, slot_start, slot_end,
          calendar, simulated, intake, escalation_reason, handoff_action, confirmation_status, after_hours)
       VALUES ($1,$2,$3,$4,$5,$6,'Dr. Lee',
               ${outcome === 'booked' ? `${start}` : 'NULL'},
               ${outcome === 'booked' ? `${start} + '30 min'` : 'NULL'},
               'Simulated calendar', true, '{}'::jsonb, $7, $8, $9, $10)`,
      [s.rows[0].id, scnId, adminId, clinicId, outcome, hasEvent ? `evt-${clinicId.slice(0, 6)}-${i}` : null, reason, handoff, confirm, afterHours],
    );
  }
}

const adminId = await getAdmin();
const scn = await scenarioId();
const northgate = await ensureClinic('northgate-family-health', 'Northgate Family Health', adminId, cfg('Northgate Family Health'));
const riverside = await ensureClinic('riverside-family-health', 'Riverside Family Health', adminId, cfg('Riverside Family Health'));

// Northgate: busy, high booking rate, a couple after-hours captured.
await seedOutcomes(northgate, adminId, scn, [
  ['booked', true, false, null, null, 'sent'],
  ['booked', true, false, null, null, 'sent'],
  ['booked', true, false, null, null, 'partial'],
  ['booked', true, true, null, null, 'sent'],
  ['no_slot', false, false, null, null, null],
  ['escalated', false, true, 'requested_human', 'voicemail', null],
  ['escalated', false, false, 'unresolved', 'warm_transfer', null],
  ['booked', false, false, null, null, 'sent'],
]);

// Riverside: smaller, different mix — proves the per-clinic view changes.
await seedOutcomes(riverside, adminId, scn, [
  ['booked', true, false, null, null, 'sent'],
  ['no_slot', false, false, null, null, null],
  ['escalated', false, true, 'requested_human', 'callback', null],
]);

// Make Northgate the active clinic for admin.
await p.query(
  `INSERT INTO user_setting (user_id, key, value) VALUES ($1,'active_clinic',$2::jsonb)
   ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
  [adminId, JSON.stringify({ clinicId: northgate })],
);

console.log('seeded WS-B demo:');
console.log('  admin:', adminId);
console.log('  Northgate:', northgate, '(active)');
console.log('  Riverside:', riverside);
await p.end();
