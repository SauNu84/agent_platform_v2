# ADR-008 — Telephony tenant binding: dialed number → clinic → payer → engine

**Status:** Accepted (2026-10-12, CTO ruling on SAU-525)
**Context:** SAU-525. The PSTN bridge (`telephony/bridge-server.ts`) picked its model from a
global env var and ran with `userId: null`, so a clinic call could neither be tiered, metered
to a tenant, nor run on `gpt-realtime-2.1-mini` without moving paid web users off premium.

## Decision

### 1. Two nullable columns on `clinic` (migration 0027)
`phone_number` (E.164, partial unique index ⇒ one number, one tenant) and `voice_engine`
(a **grade**, `standard | premium`, not a model id).

- **Grade in data, model ids in env.** `model_tier_binding` binds *tier → model id*; the need
  is *tenant → engine grade*. Vendor model ids get renamed (`gpt-realtime-mini` →
  `gpt-realtime-2.1-mini` this quarter). With a grade in tenant rows a vendor bump is one env
  change. With model ids in tenant rows it is a data migration across every tenant, and a
  partly-applied one pins tenants to a model that no longer exists.
- **Columns over a `clinic_telephony` side table.** A side table has two representations of
  "not configured" (no row, and a row of nulls) that every reader must handle; two nullable
  columns have one.
- **Trigger to revisit:** extract to a `clinic_telephony` table when **(a)** a clinic needs
  **more than one number** (multi-location), or **(b)** telephony config passes **~4 columns**.
  Both are mechanical migrations.

### 2. Payer = creator *while still an `owner` member*, else the earliest `owner` member
Resolved by `Store.getClinicPayer()`. The creator is used only if they are **currently** an
`owner`-role member of that clinic. A creator who left, was offboarded, or was downgraded falls
through to the earliest current owner. If there is no current owner, the call is refused
(`no_owner`). Charging an ex-member would refuse a clinic's calls on a stranger's spent cap
and attribute the tenant's `voice_usage` to someone with no relationship to it.

- A fall-through past a set creator is logged (`payer_fallback`), so a moving payer shows up
  as a signal and not as a wrong bill.
- **Upgrade path (not taken, YAGNI):** a dedicated `billing_user_id` column, once a clinic
  needs a payer who was never a member.

### 3. Scoped system actor for the pre-principal lookup: a bounded exception
An inbound webhook has no user, but something has to read `clinic` before a principal exists.
Admission runs only the tenant lookup under `BRIDGE_SYSTEM_ACTOR` (admin GUC, nil user). The
call itself runs as `{owner, clinic}`. No RLS policy was added or widened, and
`tests/call-admission-rls.test.ts` proves the wall as `app_rw`.

- **Reservation:** the admin GUC is a broad grant for a narrow read. Socket events firing
  outside any `AsyncLocalStorage.run` scope have already bitten this code once.
- **Preferred target shape:** a `SECURITY DEFINER` function
  `resolve_clinic_by_phone(text) → (clinic_id, owner_user_id)` granting exactly one read.
- **Trigger:** **the moment a second pre-principal lookup is needed, build the function
  instead of reusing the admin actor.** One admin-scoped lookup is a bounded exception; two is
  a pattern.
- The actor/RLS question and SAU-541's use of `TWILIO_AUTH_TOKEN` as the HMAC key are on record
  for CISO review. That review is not a merge gate, but it is required before any tunnel opens
  (SAU-533).

## Consequences
- The clinic path runs mini (grade `standard`) without touching `VOICE_ENGINE_PAID`. Web users
  are unaffected.
- Every bridge call is metered to a current owner. There is no unmetered path:
  `TELEPHONY_FALLBACK_CLINIC` is a slug and is still metered.
- Out of scope: `TELEPHONY_PUBLIC_URL` stays CFO-controlled (SAU-533), and bridge WS auth
  (SAU-541) lands before any tunnel opens.
