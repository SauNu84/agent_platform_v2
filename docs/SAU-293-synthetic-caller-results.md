# SAU-293 — Agent-automated live call: synthetic caller harness (results)

**Parent:** SAU-292 (live Twilio telephony stand-up). **Scope:** close the SAU-292
live leg *agent-only* per Rule #1 — an agent drives the call, not a human with a
phone. Synthetic / internal only; HIPAA gate **SAU-272** stays in force (mock
calendar, no real PHI, no real patient). Trial Twilio credit only.

## TL;DR

- ✅ **End-to-end agent-driven clinic call PROVEN** — a synthetic *patient*
  (OpenAI Realtime persona) phones the clinic agent over the real telephony bridge
  and the agent runs its true flow: **intake → `check_availability` →
  `create_appointment` → booked**, with a real (mock-calendar) **event id
  `sim-evt-1-1`**. Repeatable in one command, no tunnels, no Twilio credit.
- 🐞 **Two real bugs in the shipped telephony bridge were found and fixed** — the
  live bridge could **never** have completed a call before this:
  1. It used the **sunset OpenAI Realtime *Beta* API** (`OpenAI-Beta: realtime=v1`
     + beta session shape) → every session died with `beta_api_shape_disabled`.
  2. Even after connecting, its `server_vad` had no **`create_response`**, so the
     agent **never replied** to a caller.
- 🚧 **Live PSTN edge:** an agent **can** originate an outbound call to our own
  trial number (real Call SID + recording captured), and the public tunnel → bridge
  → OpenAI path is reachable — but the Twilio **trial "press any key" gate** blocks
  the streaming TwiML from running without a human keypress. **Precise board item:
  upgrade off the Twilio trial** to close the fully-automated live PSTN media leg.

## What proved the deliverable

### `scripts/synthetic-caller.ts` + `scripts/synthetic-call-e2e.sh`

A **test-only** synthetic caller (never in the product path). It:

1. Connects to the real bridge (`npm run bridge`) **impersonating a Twilio Media
   Streams client** (`connected` → `start` → `media`/`stop`, μ-law @ 8 kHz base64).
2. Plays the **patient** side with a **second OpenAI Realtime session** given a
   patient persona ("Jordan Avery", DOB 1990-03-12, persistent cough, Aetna, earliest
   morning slot). Two realtime agents converse over the exact media path a live PSTN
   call uses.
3. **The crux of turn-taking:** a **continuous 20 ms μ-law pump in both directions** —
   real audio when queued, μ-law silence (`0xFF`) otherwise. A real phone line always
   carries audio; without the trailing silence the agent's server VAD never detects
   end-of-speech and never replies. This is what made dynamic turn-taking work.
4. Captures the outcome from the bridge's own `finalize` log (`outcome`, `eventId`)
   and a full dialogue transcript (from the patient session's transcription events).

Run it:

```bash
cd app && ./scripts/synthetic-call-e2e.sh
```

### Verified result (clean run, 2026-06-14)

```
patient: Hi there! I'd like to book an appointment for myself.
agent:   Of course… Could you start by telling me your full name?
patient: Sure. My full name is Jordan Avery.
agent:   Thanks, Jordan. And could you share your date of birth as well?
patient: It's March 12th, 1990.
agent:   What's the reason for your visit?
patient: I've had a persistent cough for about two weeks.
…(insurance, doctor, slot)…
agent:   We have an available slot with Dr. Amara Chen on Monday, June 15 at 9 a.m…
agent:   Your appointment is confirmed… confirmation event ID is sim-evt-1-1.

bridge tool_call: check_availability
bridge tool_call: create_appointment
bridge finalized: outcome=booked  eventId=sim-evt-1-1
```

All four capture items for the conversation are met: intake completed, booking on a
test calendar, the created **event id** (`sim-evt-1-1`), and a full transcript.

## The two shipped-bridge fixes (the real blockers)

Both are in `src/services/telephony/openai-realtime-session.ts` (covered by
`tests/telephony.test.ts`):

1. **GA Realtime migration.** Dropped the `OpenAI-Beta: realtime=v1` header and moved
   to the GA `session.update` shape: audio nested under `audio.input` / `audio.output`,
   format as an object `{ type: 'audio/pcmu' }` (G.711 μ-law, transcode-free), and
   `output_modalities` replacing top-level `modalities`. (The browser voice path was
   already migrated under SAU-176; the telephony path was missed.)
2. **`create_response: true`** (+ `interrupt_response: true`) on the server-VAD
   `turn_detection`. Without it the GA agent listens forever and never speaks.

Verified live: with both fixes, a real OpenAI Realtime session completes the
intake → booking flow over the bridge.

## Live PSTN edge — findings (`scripts/live-pstn-record.sh`)

| Question | Result |
|---|---|
| Can an agent originate an outbound call to our own trial number `+14783754797`? | **Yes.** Trial does *not* block it. Real Call SID `CA08a2ad0eb1088d3e4d1a6b6c3d0c46b4`, $0.01. |
| Recording? | **Yes** — recording `RE3948b8ff…`, 9 s (`…/Recordings/RE3948b8ff6108b3a1990d28b344f7e587.mp3`). |
| Is the public tunnel → bridge → OpenAI path live? | **Yes** — a direct WS client through the cloudflared URL produced `connection` + `bridge_started` (OpenAI session opened). |
| Did the streaming TwiML reach the bridge on the **trial** call? | **No** — 0 bridge connections; the 13 s call / 9 s recording is the Twilio **trial "press any key" notice**, which runs *before* our `<Connect><Stream>` and needs a human keypress an automated call can't supply. |

### Why a fully synthetic *conversation* can't traverse one trial self-call

Even off-trial, a Twilio `<Connect><Stream>` leg is wired to **exactly one socket**.
A two-party conversation (agent + synthetic patient) would need *both* parties as
media endpoints on the *same* leg, which isn't possible — `<Connect>` connects the
leg to one stream, not to another leg. So the live PSTN call proves the **edge**
(Twilio media reaches our bridge + recording + Call SID); the **conversation** is
proven by the synthetic caller above, which doesn't need PSTN. This is the correct
split, not a workaround.

### Precise board-upgrade item

To close the **fully-automated live PSTN media leg** (Twilio → bridge → agent, no
human), the Twilio account must be **upgraded off trial** (removes the mandatory
"press any key" gate). Per SAU-292/SAU-276, no paid upgrade or number purchase
without **board approval**. Until then, the SAU-292 fallback stands: an internal
tester runs `scripts/live-call-up.sh` and dials + presses a key — the agent then
answers live over real PSTN (now that the GA + `create_response` fixes are in).

## Scope / safety

- All callers synthetic/internal; mock calendar; no real PHI; HIPAA gate SAU-272 in
  force. Real patients require pilot **SAU-290**.
- `scripts/*` are **test-only**, never imported by the product. The outbound test
  call dials *our own* number only (no third party → no TCPA concern).
- Tunnels are ephemeral (trycloudflare) — the live edge test runs in one session.
