# SAU-274 — Production encryption key + PHI-at-rest encryption (Phase 1 · WS5)

**Parent gate:** SAU-272 (HIPAA/PHI go-live). First-class blocker.
**Owner:** Senior Full-Stack Developer. **Ciphertext format coordinated with:** CISO (SAU-272 / SAU-276).
**Status:** Application-layer PHI encryption shipped + verified. Two operational items below
(prod key custody, managed-Postgres at-rest confirmation) are deployment actions, not code.

---

## 1. What is encrypted, and how

PHI is encrypted **at the application layer** before it ever reaches Postgres, reusing the
SAU-260/261 AES-256-GCM envelope (`app/src/lib/crypto.ts`). The PHI seam is
`app/src/lib/phi.ts`; it wraps the `iv:ct:tag` ciphertext in a one-key jsonb object so the
columns stay `jsonb` and each row is self-describing:

```
plaintext   { "name": "Jane Doe", "dob": "1990-01-01", "reason": "...", "insurance": "..." }
at rest     { "_enc": "<base64 iv>:<base64 ciphertext>:<base64 GCM tag>" }
```

Encryption/decryption happen **only** at the PgStore boundary (`app/src/db/pg-store.ts`), so
every read decrypts and every write encrypts with no change to the dozens of callers:

| PHI surface | Column (jsonb) | Write site | Read site |
|---|---|---|---|
| Clinic intake (name/DOB/reason/insurance) | `clinic_session_outcome.intake` | `recordClinicOutcome` | `rowToClinicOutcome` |
| Call transcript | `session.transcript` | `completeSession` | `rowToSession` |
| Live transcript + tool payloads | `session_event.payload` | `appendSessionEvent` | `listSessionEvents` |

**Algorithm:** AES-256-GCM (authenticated — tamper on disk fails the GCM tag on decrypt).
Random 12-byte IV per value, 16-byte tag. Same wire shape the CISO already signed off for
provider keys (SAU-262), so this is one ciphertext format across the platform.

**Not encrypted (documented decision):** the booking-outcome operational columns
`event_id / event_link / doctor_id / doctor_name / slot_start / slot_end / calendar`. These are
non-identifying scheduling metadata and are queried/joined directly. Patient identity lives in
`intake` (encrypted). Patient↔booking linkage is further protected by row access control and the
managed-Postgres at-rest disk encryption in §3. *(If CISO wants doctor/slot treated as PHI, it is
a one-line addition per column — flagged for the format review.)*

**Backward compatibility & backfill:** `decryptJson` passes legacy plaintext rows through
unchanged, so reads worked before the upgrade. Data migration `0017_encrypt_phi`
(`app/src/db/migrate-encrypt-phi.ts`, registered in `migrate.ts`) re-encrypts any Phase-0
plaintext rows; it is row-level idempotent (`{ _enc }` envelopes are skipped). Verified live on
the `:5433` dev DB: **304 plaintext rows re-encrypted (3 intake + 24 transcripts + 277 event
payloads); 0 plaintext PHI rows remain.**

---

## 2. The encryption key — custody, provisioning, rotation

The PHI key **is** the provider-secret key: a single 32-byte value in `SETTINGS_ENCRYPTION_KEY`
(64 hex chars). One key, one rotation story.

- **Production is fail-closed.** `crypto.ts` runs `resolveKey()` at import; under
  `NODE_ENV=production` a missing/malformed key **throws at startup** — the server will not boot
  serving PHI under a guessable key. Dev/test fall back to a fixed INSECURE key with a one-time
  warning (so CI needs no setup); that key is never used in production.
- **Provision (prod):** generate and store the key in the platform secret manager
  (e.g. cloud KMS / secrets store), injected as an env var at deploy — **never** committed,
  baked into an image, or logged.
  ```
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **Custody:** secret-manager access is least-privilege (deploy role + named break-glass admins);
  access is audit-logged by the secret manager. The value never appears in app logs — only row
  *counts* are logged by the backfill, never PHI or key material.
- **Rotation:** because the envelope stores the IV per value (not the key), rotation is a
  re-encrypt pass, identical in shape to the `0017` backfill: stand up the new key, decrypt with
  old + re-encrypt with new per row, cut over. For a clean key boundary, add a key-id prefix to
  the envelope when the first rotation is scheduled (not needed for go-live; noted for the
  rotation runbook). Recommended cadence: annual, or immediately on suspected compromise.

---

## 3. DB-level (host) encryption posture — feeds the BAA / cloud-host item

Application-layer encryption protects PHI in dumps, WAL, and base backups even if the host disk
is readable. It is **defense-in-depth on top of**, not a replacement for, managed-Postgres
encryption at rest:

- **Requirement for go-live:** the production database MUST be a HIPAA-eligible managed Postgres
  with encryption at rest enabled (AES-256 volume encryption) under a signed BAA. Candidates align
  with the SAU-276 vendor path (managed Postgres + at-rest, BAA in scope).
- **Confirmation owner:** this is a procurement/infra confirmation (CISO/CTO, SAU-276/277), not a
  code change. The application-layer envelope above means a host-encryption misconfiguration does
  **not** expose plaintext PHI on its own — but both layers are required for the gate.
- The local Docker dev DB is **not** encrypted at rest and must never hold real PHI (synthetic
  only), consistent with the SAU-268 PHI boundary.

---

## 4. Tests / evidence

- `app/tests/phi-encryption.test.ts`
  - **Unit (always CI):** envelope round-trip; at-rest shape carries ciphertext not plaintext
    (asserts patient name/DOB absent); `isPhiEnvelope` vs plaintext; legacy-plaintext pass-through;
    idempotent backfill decision.
  - **DB-gated (`DATABASE_URL`):** after writing intake + transcript + event through the store,
    the **raw jsonb on disk contains no patient name, DOB, or transcript text — only `_enc`
    ciphertext** — and reads decrypt back. Idempotent backfill re-run.
- Live verification (`:5433`): all 7 PHI tests pass; direct `psql` shows `intake`/`transcript`/
  `payload` as `{"_enc": "..."}`; 0 plaintext PHI rows across all three columns post-backfill.
- Full suite: 230 pass / DB-gated skipped in CI; `tsc --noEmit` clean; `next lint` clean.

---

## 5. Go/no-go for the gate (SAU-272 checklist input)

| Item | State |
|---|---|
| PHI encrypted at rest (intake, transcript, event payload) | ✅ shipped + verified live |
| Ciphertext format coordinated with CISO | ⏳ this doc is the format proposal for sign-off |
| Production `SETTINGS_ENCRYPTION_KEY` provisioned (not dev fallback) | ⛔ deploy action — fail-closed enforced in code; key must be set in prod secret store |
| Managed-Postgres at-rest encryption confirmed under BAA | ⛔ infra/procurement confirmation (SAU-276/277) |

No real PHI flows until the two ⛔ items are confirmed green.
