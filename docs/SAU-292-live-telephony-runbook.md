# SAU-292 — Live Twilio telephony stand-up (runbook + status)

**Parent:** SAU-265 · **Continues:** SAU-282 (deferred live leg) · **Branch:** `sau-282-integrate-telephony`

Synthetic / internal test callers **only**. A real-patient call still requires a signed
pilot clinic (SAU-290) and the HIPAA gate (SAU-272) in force. Secrets live in
`app/.env.local` (gitignored) — never commit, never echo the auth token.

## What's wired and proven (agent-doable, done this heartbeat)

| Leg | State | Evidence |
|-----|-------|----------|
| Twilio creds | ✅ validated | account `SauNu`, **Trial**, `active`, balance $15.50, HTTP 200 (read-only) |
| Live adapter activation | ✅ | `npm run verify:telephony` → telephony + handoff + SMS all `simulated=false` |
| Trial number claimed | ✅ | **+14783754797** (voice+SMS), PN `PNba2b2c4110f61281fbb86f5dcfb65ec3`, free (trial credit) |
| Bridge server | ✅ runs & listens | `npm run bridge` → `:5050`, WS upgrade reaches handler, scenario lookup runs |
| Public tunnel | ✅ proven | `cloudflared` quick tunnel (no account); public `wss → cloudflared → bridge` opened & routed |
| **End-to-end live call** | ⏳ **human leg** | requires a person to physically dial the number — see below |

### Fixes shipped
- **`npm run bridge` now loads `.env.local`** (`--env-file-if-exists`). Previously the
  standalone bridge saw no `OPENAI_API_KEY`/Twilio creds (tsx doesn't auto-load env) and
  closed every call socket with 1011. Now fail-soft only when the key is genuinely absent.
- **`npm run verify:telephony`** — activation check (`src/telephony/verify-live.ts`):
  reports presence/adapters/masked SID, **never** secrets; exits non-zero if the live
  telephony/handoff adapters don't activate.
- **`scripts/live-call-up.sh`** — one-command bring-up of the full live path.

## Run a live test call (one command + dial)

```bash
cd app
./scripts/live-call-up.sh        # brings up bridge + 2 tunnels, points the number's webhook
# → prints: "DIAL +14783754797 NOW"
```

The script: starts the bridge (`:5050`) → cloudflared tunnel → exports `TELEPHONY_PUBLIC_URL`
(`wss://…trycloudflare.com`) → `next dev` (`:3000`, `TWILIO_VERIFY_SIGNATURES=false` tunnel
escape hatch) → second tunnel → **PATCHes the number's Voice "A CALL COMES IN" webhook** to
`https://…/api/telephony/twilio/incoming-call`. Ctrl-C tears down and restores the prior webhook.

A human (internal/synthetic tester) then **dials +14783754797**, presses a key past the
trial notice, and talks to the clinic agent: intake → booking on a **test** calendar.

## The one genuinely non-agent-doable item

**Physically placing the inbound call.** Everything up to the dial tone is automated and
proven; an agent cannot pick up a phone and call the number. This needs an internal tester
on the line while `live-call-up.sh` is running (tunnels are ephemeral — they die when the
script stops, so the caller must be standing by during the same session).

Two smaller caveats (not blockers):
- **Trial number restrictions:** inbound works and plays a one-time trial notice; outbound
  dials/SMS only reach **verified** numbers. A warm transfer (`TWILIO_TRANSFER_TO`) or
  confirmation SMS in a live test must target a Twilio-verified number, or the board upgrades
  off Trial for unrestricted use (**paid → board approval first**).
- **Tunnels are ephemeral** (`trycloudflare.com`). Fine for a live test; a durable
  deployment wants the bridge + webhook on a stable public host (deploy leg, post-pilot).

## Config knobs (env)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — present ⇒ live adapter (done).
- `TWILIO_PHONE_NUMBER=+14783754797`, `TWILIO_SMS_FROM=+14783754797` — set (done).
- `TELEPHONY_PUBLIC_URL=wss://…` — the bridge tunnel; set by `live-call-up.sh` at runtime.
- `TWILIO_VERIFY_SIGNATURES=false` — tunnel-only escape hatch (the public URL Twilio signs
  differs behind a tunnel); the script sets this. Leave **true** on a stable host.
- `TWILIO_TRANSFER_TO` — clinic staff line for warm transfer (optional → voicemail).
