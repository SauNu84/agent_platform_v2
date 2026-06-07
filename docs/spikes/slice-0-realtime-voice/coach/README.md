# Coach — Slice-0 voice-agent foundation (SAU-194)

The **minimal, runnable** voice-agent skeleton built on the spike seam. Vendor =
**OpenAI Realtime** (settled in [ADR-003](../../../adr/ADR-003-realtime-voice-build-vs-buy.md),
Accepted). Deliberately small — this is the foundation; we improve later.

```
mic/audio in  →  RealtimeVoiceProvider (behind realtime-interface.ts)  →  audio out
                 + tools (saveReflection / recallReflections) + barge-in + transcript
```

## Run it

```bash
cd docs/spikes/slice-0-realtime-voice
npm install                       # once

# Offline, deterministic, ZERO spend — proves the wiring end-to-end via the mock adapter.
npm run coach:mock

# LIVE OpenAI Realtime (needs OPENAI_API_KEY in ../.env or the env; synthetic audio only).
npm run coach:fixture             # (macOS) regenerate the synthetic demo audio — committed manifest already present
npm run coach                     # = tsx coach/run.ts --vendor openai --realtime
```

Both runs drive the same short **synthetic** coaching conversation and print the
turns live, then self-check that all three required properties fired:

```
[coach] demonstrated:  audio-out=✅  tool-call=✅  barge-in=✅
```

The process exits non-zero if any of the three did not happen, so the entry point
is a real proof, not just a log. The finished transcript is persisted by the
minimal `CoachMemory` stub to `coach/.sessions/synthetic-<vendor>.json` (gitignored).

## Files

| File | Role |
| --- | --- |
| `voice-agent.ts` | **The foundation.** `VoiceAgent` wires a conversation loop on any `RealtimeVoiceProvider`. Depends ONLY on `realtime-interface.ts` — this is the reversibility ADR-003 requires. |
| `coach-scenario.ts` | The Coach persona (system prompt) + two tool definitions. |
| `memory.ts` | `CoachMemory` — the minimal persistence stub (flat JSON). Full model = ADR-004, a later slice. |
| `run.ts` | The documented entry point: builds a `VoiceAgent`, drives the synthetic fixture, demonstrates tool-call + barge-in, persists the transcript. |
| `make-coach-fixture.ts` | Generates the synthetic demo audio (macOS `say`, zero spend, no PII). |

## How to extend

- **Add a tool:** add it to `COACH_SCENARIO.tools` in `coach-scenario.ts`, then pass
  a handler under the same name in the `tools` map to the `VoiceAgent` constructor
  (see `run.ts`). The agent auto-registers every declared tool.
- **Swap the vendor:** construct `VoiceAgent` with a different
  `RealtimeVoiceProvider` (e.g. a future `adapters/<vendor>.ts`). Nothing else changes —
  that is the point of the interface.
- **Wire a real transport (UI / telephony):** feed mic frames to `agent.sendAudio(pcm)`
  (PCM16 mono 24 kHz) and consume `onEvent` for audio-out + transcripts. `run.ts`'s
  fixture driver is just one such transport.
- **Real persistence:** replace `CoachMemory` with a DB-backed implementation when
  ADR-004 lands; the method surface (`saveReflection` / `recallReflections` /
  `saveTranscript`) is the contract.

## Scope guardrails (carried from the issue / ADRs)

- **Not built now (the "improve later"):** latency tuning toward ≤800/≤500 ms (MVP
  ships at the measured ~1.3 s p50, a deliberate board trade), multi-vendor/cascade,
  scale/cost optimization, full memory model, UI polish.
- **Privacy gate (ADR-003):** synthetic audio only — no real-user PII until the
  OpenAI DPA / no-train / retention follow-up closes. The demo fixture is macOS-`say`
  speech; keep it that way.
