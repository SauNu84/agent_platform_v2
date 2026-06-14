# SAU-285 — PHI retention auto-deletion (Phase 1 · WS5)

**Parent:** SAU-272 (HIPAA/PHI go-live gate). This is **gate item 11** — the
*enforcement* of the retention/disposal policy (program doc §4), which was already
*approved* but not yet enforced.

**Owner:** Senior Full-Stack Developer. Windows coordinated with CISO (program doc §4).

## What this delivers

An automatic, idempotent, audit-logged purge that crypto-shreds / deletes PHI once
it is past its retention window, plus the schema affordances it needs.

### Finding: SAU-156's purge is in a *different* codebase
The issue points at SAU-156's "scheduled retention-purge + erasure framework" to
*extend*. That job exists, but in the **`platform/` Commerce+Orgs JS codebase**
(`platform/api/src/lib/billing.js`, `platform/db/…`) — it purges `org_invitation`,
`usage_record`, and `app_user` identity. The clinic PHI tables
(`clinic_session_outcome`, `session`, `session_event`, `phi_access_log`) live only
in **this** `agent_platform_v2` Next.js/TS app, which has no scheduled purge. So the
PHI purge is **built here**, following SAU-156's *pattern* (idempotent, config-driven
windows, non-PII audit rows, safe to re-run), not extending its code.

## Windows (program doc §4 / SAU-285)

| PHI | Window (default) | Disposal | Per-clinic override |
|---|---|---|---|
| Call transcripts + audio + live event payloads | **30d** | `session.transcript / transcript_uri / recording_uri` → `NULL` (crypto-shred); `session_event` rows → `DELETE` | `transcriptDays` |
| Patient intake + booking-outcome records | **1y (365d)** | `clinic_session_outcome` row → `DELETE` | `intakeDays` |
| `phi_access_log` | **6y** (§164.316(b)(2)) | **RETAINED — never purged early** (append-only by privilege + trigger, migration 0018) | — |

Windows are config-driven: env defaults (`PHI_RETENTION_TRANSCRIPT_DAYS`,
`PHI_RETENTION_INTAKE_DAYS`, `PHI_RETENTION_AUDIT_LOG_YEARS`) overridden per clinic
via the `clinic.retention` jsonb column, so each clinic BAA can set its own window.

## Crypto-shred (not just delete)

PHI is encrypted at rest (SAU-274). The encrypted column/row is the **only** copy of
the ciphertext — nulling the column or deleting the row destroys the data
irrecoverably. The encryption key alone cannot recover a destroyed ciphertext.
**Backups age out within the same retention window** (operational note for the
program doc): a backup taken before disposal must not be retained past the window,
or it reintroduces the PHI. This is a backup-lifecycle policy item, not code.

### Why shred-then-delete, not a single cascade
Booking proof (outcome / calendar event id) lives in the **same** row as the
encrypted intake, on a **longer** window (1y) than the transcript (30d), and
`session_event` + `clinic_session_outcome` both `ON DELETE CASCADE` from `session`.
So we cannot delete the `session` at 30d (it would cascade-destroy the 1y intake).
Instead: at the transcript window we **null** the session's transcript/audio columns
and **delete** its event rows; at the (later) intake window we delete the whole
`clinic_session_outcome` row.

## Scope

Only sessions/outcomes belonging to a **provisioned `clinic`** (clinic_id set) are
PHI under this job. Non-clinic coaching/training sessions follow the separate
ADR-004 / SAU-156 retention track and are intentionally untouched.

## Accountability

Every disposal appends a **`purge`** row to `phi_access_log` — one per disposed
`(clinic, entity, session)` — HMAC-stamped like every other PHI access, giving
per-patient tamper-evident disposal provenance. `refs` carries only the window
label (e.g. `{"window":"30d"}`), never PHI. The audit log is append-only, so the
disposal record itself cannot be altered or removed.

## How it runs

The purge is a recurring **maintenance job**, not a one-time migration. Run it from
a scheduler (nightly Kubernetes CronJob / ECS scheduled task / `cron`) with
maintenance DB credentials:

```
DATABASE_URL=postgres://… npm run purge:phi              # apply
DATABASE_URL=postgres://… npm run purge:phi -- --dry-run # report only, writes nothing
```

It runs in a single transaction with `app.is_admin='on'`, so it is correct under the
runtime RLS role (`app_rw`) as a system maintenance op and a no-op-extra under the
owner/superuser connection migrations use. The acting principal is logged as
`system:retention-purge`. Exit code is non-zero on failure so a scheduler can alert.
The JSON report (counts only, never PHI) is the run's disposal evidence.

## Files

- `app/db/migrations/0019_phi_retention.sql` — `clinic.retention` jsonb override
  column; widen `phi_access_log` action CHECK to include `'purge'`.
- `app/src/services/retention-policy.ts` — config-driven windows (env defaults +
  per-clinic override resolution).
- `app/src/db/retention-purge.ts` — `purgeExpiredPhi(pool, {now, dryRun})`: the
  engine (per-clinic shred/delete + append-only purge audit). Idempotent.
- `app/src/db/retention-purge-cli.ts` + `npm run purge:phi` — cron entrypoint.
- `app/src/lib/phi-audit.ts`, `app/src/db/store.ts` — widen the PHI action union to
  include `'purge'`.
- `app/tests/retention-purge.test.ts` — pure window-resolution unit tests +
  DATABASE_URL-gated regression.

## Verification

- `tsc --noEmit` clean; `eslint` clean.
- **242 tests, 240 pass / 2 pre-existing skips / 0 fail.** New: 4 pure unit tests +
  1 live regression (past-window disposed, recent + override-clinic retained,
  `phi_access_log` retained, disposal audit-logged, idempotent, dry-run writes nothing).
- **Live end-to-end on :5433** via `npm run purge:phi`: a 400-day-old provisioned
  clinic session (transcript + audio + event + intake) → after one run, 0 transcripts
  / 0 intakes / 0 events left, **3 append-only `purge` audit rows** written, and
  `phi_access_log` grew with **zero deletions**. Dry-run reported the same counts and
  changed nothing. Test fixtures cleaned up.

## Coordinate with CISO

The defaults (30d / 1y / 6y) match the issue / program doc §4. The retention
**register** and the **backup-aging** operational note (backups must not outlive the
window) are policy items for the program doc — flagged here, owned by CISO. This
closes gate item 11's *engineering* leg; the gate item flip + go/no-go stay CISO's.
