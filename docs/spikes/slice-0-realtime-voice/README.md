# Slice-0 — Realtime Voice Spike (the de-risk)

- **Issue:** SAU-175 · **Author:** Enterprise Architect · **Date:** 2026-06-06
- **Goal:** stand up the thinnest possible path — **one hardcoded Scenario → one live voice session → transcript persisted** — against **2–3 realtime vendors**, behind a single stable interface, and produce a **decision-grade benchmark table**.
- **Feeds:** [ADR-003](../../adr/ADR-003-realtime-voice-build-vs-buy.md) (vendor recommendation — currently *Proposed*, blocked on these measured numbers).

> **Status of this folder:** the **interface contract, benchmark methodology, and harness skeleton are committed and ready to run.** The *measured run* requires paid vendor credentials + a host app to run WebRTC against (neither exists in this repo). That run is delegated to engineering and is the named blocker on [ADR-003](../../adr/ADR-003-realtime-voice-build-vs-buy.md) (see the linked child issue). Drop these files into the app workspace, supply credentials, run the bench, fill `RESULTS.md`.

## The hard boundary (non-negotiable — ADR-003)

Every vendor sits behind `realtime-interface.ts`:

```
startSession(scenario) → {
  events: AsyncIterable<SessionEvent>,   // ordered: audio, transcripts, tool.call/result, ui.effect, barge-in
  sendAudio(pcm), registerTool(def, handler), interrupt(),
  stop() → Promise<Transcript>
}
```

The bench and the eventual platform depend **only** on this interface. A vendor = one `RealtimeVoiceProvider` adapter. Swapping vendors must touch *only* its adapter file.

## Candidates

1. **OpenAI Realtime API** (`gpt-realtime`, native S2S)
2. **Google Gemini Live** (native audio + half-cascade)
3. **LiveKit Agents** (framework; cascade or pluggable S2S) — also exercises the cascade path
4. **Pipecat** (framework; cascade or S2S) — *optional 3rd/4th if time permits*

(Cartesia is a cascade TTS/STT component used *under* LiveKit/Pipecat, not a standalone candidate.)

## What we measure (and exactly how)

Replay a **fixed scripted audio fixture** (the same `fixtures/driver.wav` for every vendor) so results are comparable. The fixture contains: a normal turn, a turn that **forces a tool call**, and a deliberate **barge-in** (user speaks over agent playback). N ≥ 50 measured turns per vendor.

| Metric | Definition | Captured from |
|---|---|---|
| **TTFA p50 / p95** | end of user utterance (VAD end) → first `audio.output` frame | event timestamps |
| **Barge-in stop** | `user.speech.started` during agent playback → agent audio stops (`agent.interrupted`) | event timestamps |
| **Mid-turn tool calling** | does agent audio keep flowing between `tool.call` and `tool.result`? max dead-air gap | event stream gap analysis |
| **Cost / conversation-min** | measured vendor usage (audio in/out tokens or minutes) × published rates, projected to target volume | vendor usage API + rate card |
| **Swap effort** | LOC + hours to implement the adapter against this interface | engineer log |
| **Operability** | reconnect on transport drop; error events; metrics surfaced | observation |

**Projected volume for cost — CFO-ratified:** **Base = 10,000 conversations/mo × 6 min = 60,000 conv-min/mo** (headline). Also capture **Bull = 300,000 conv-min/mo** for any vendor with committed-use pricing. Full scenarios + the cost pass-bar envelope: [COST-ENVELOPE.md](./COST-ENVELOPE.md). Compute cost at *realistic conversation length with accumulating context*, not active-audio-only (S2S models bill the growing context per turn).

## Pass bars (from ADR-003 rubric)

- TTFA: **p95 ≤ 800 ms**, p50 ≤ 500 ms target
- Barge-in: clean stop **≤ 300 ms**, no audio overrun
- Mid-turn tool call: **yes**, no dead air > 1.5 s
- Cost: within the unit-economics envelope (CFO sign-off)

## How to run

The workspace is self-contained and runnable today (`package.json` + `tsx`). Node ≥ 22.6 can also run the `.ts` files directly via `node --experimental-strip-types`.

```bash
npm install                       # tsx + typescript + @types/node

# 0. (re)generate the fixed fixture
npm run fixture                   # tone placeholder (fast, offline mock path)
npm run fixture:speech            # macOS only, ZERO spend — real TTS speech via `say`,
                                  # writes driver.wav + per-turn offsets for live runs

# 1. PROVE THE HARNESS OFFLINE — no credentials, no spend.
npm run typecheck                 # tsc --noEmit, must be clean
npm test                          # harness.test.ts — metric math assertions
npm run bench:mock                # full N=50 end-to-end against the mock adapter
                                  # → metrics + persisted transcript + out/mock-report.json
```

Then, **once spend is approved** (the named blocker — see ADR-003 child issue):

```bash
# 2. credentials — EITHER export them, OR drop them in a gitignored `.env` here
#    (SAU-181: `.env` is preferred when the heartbeat run env doesn't inject keys;
#     bench.ts auto-loads ./.env at startup. Exported vars take precedence.)
#
#    .env  (in this directory; already in .gitignore — NEVER commit):
#      OPENAI_API_KEY=sk-...
#      GOOGLE_API_KEY=...
#      LIVEKIT_URL=...
#      LIVEKIT_API_KEY=...
#      LIVEKIT_API_SECRET=...
#      CARTESIA_API_KEY=...
#
#    …or the equivalent exports:
export OPENAI_API_KEY=...         # OpenAI Realtime
export GOOGLE_API_KEY=...         # Gemini Live
export LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...
# (+ STT/LLM/TTS keys for LiveKit/Pipecat cascade mode, e.g. CARTESIA_API_KEY)

# 3. generate the real speech fixture (once), then run the bench at 1x pacing.
npm run fixture:speech            # real driver.wav via macOS `say` (no spend)
npx tsx bench.ts --vendor openai  --turns 50 --realtime
npx tsx bench.ts --vendor gemini  --turns 50 --realtime
npx tsx bench.ts --vendor livekit --turns 50 --realtime
# On non-macOS hosts, generate driver.wav with any TTS/recording at the manifest's
# sampleRate (PCM16 mono) matching the per-turn offsets, or record one take.

# 4. each real-vendor run upserts its row in RESULTS.md and archives raw JSON in ./out/
```

> The mock adapter exists ONLY to validate the harness offline (it is not a vendor and never writes to the RESULTS.md vendor table). It is the proof the measurement pipeline is correct before a single dollar is spent.

## Acceptance (SAU-175)

- Slice-0 works **end-to-end on ≥ 1 vendor** (live voice → transcript persisted).
- `RESULTS.md` benchmark table covers **latency, tool-calling, and cost** across the candidates evaluated.
- [ADR-003](../../adr/ADR-003-realtime-voice-build-vs-buy.md) is updated to **name a recommended vendor grounded in these numbers**, then escalated to the CTO.

## Files

- `realtime-interface.ts` — the hard boundary (types + contract). Source of truth for the interface.
- `bench.ts` — **implemented** harness: drives a session from the fixture, buffers/windows the event stream, extracts per-turn metrics (pure, tested), persists the transcript, archives raw JSON, and upserts the `RESULTS.md` vendor row.
- `adapters/mock.ts` — deterministic in-memory adapter (NOT a vendor) used to validate the harness offline.
- `adapters/openai.ts`, `adapters/gemini.ts`, `adapters/livekit.ts` — real vendor adapters: full protocol/event translation; only the live socket is gated on credentials.
- `fixtures/fixture.ts` + `fixtures/make-fixture.ts` — the fixed turn manifest (committed, reproducible) + a placeholder WAV generator.
- `harness.test.ts` — metric-math self-test (8 assertions, incl. a deliberate fail case).
- `package.json` / `tsconfig.json` — runnable workspace (`tsx`, `tsc --noEmit`).
- `RESULTS.md` — the table to fill from live runs (mirrors ADR-003 "Measured data") + the harness-validation record.
- `coach/` — **the Slice-0 MVP voice-agent foundation (SAU-194)**: a minimal, runnable Coach agent on this seam (OpenAI behind the interface, tool-call + barge-in demonstrated end-to-end). Start at [`coach/README.md`](coach/README.md); run with `npm run coach:mock` (offline) or `npm run coach` (live).
