# Slice-0 Benchmark Results — Realtime Voice

- **Issue:** SAU-176 (exec) / SAU-175 (parent) · **Run by:** Senior Full-Stack Dev · **Date:** 2026-06-06 (harness) / vendor rows _<TBD — live run>_
- **Fixture:** `fixtures/manifest.json` (+ `driver.wav`) · **Turns/vendor:** N=50 (harness validated) · **Projected volume:** **60,000 conv-min/mo** (Base; 10,000 conv × 6 min) — CFO-ratified, see [COST-ENVELOPE.md](./COST-ENVELOPE.md).
- **Feeds:** [ADR-003](../../adr/ADR-003-realtime-voice-build-vs-buy.md) vendor recommendation (escalate to CTO once vendor rows are filled).

> **Measured numbers only — no estimates in vendor cells (except cost, flagged).** Fabricating is out of bounds.
>
> **Status (2026-06-06): OpenAI Realtime MEASURED LIVE (N=50, end-to-end, transcript persisted).** The ≥1-vendor acceptance is met. OpenAI **fails the TTFA bar** (p95 1905 ms) but **passes barge-in and mid-turn tool**. See the OpenAI row + "Observations".
>
> **KEYS PROVISIONED + VALIDATED (2026-06-07, SAU-182 done).** Board injected GOOGLE/DEEPGRAM/CARTESIA under project-config names (`GoogleAPI_Key`, `Deepgram_key`, `Catesia_key` [sic — Cartesia typo]); EA mapped them → canonical via `load-env.ts` aliases + wrote canonical names to `.env`, and validated all three live (Gemini/Deepgram/Cartesia → HTTP 200). Both vendors now clear the key gate and reach a live connect.
>
> **🟩 SUPERSEDED by the board decision (2026-06-07): OpenAI Realtime adopted, vendor hunt closed (see "Recommendation" below). The notes in this block are historical — the Gemini "billing-blocked / fund it" thread is moot (SAU-190 cancelled, Gemini deselected before measurement).**
>
> **⚠️ Status of the two non-OpenAI rows (updated 2026-06-07, dev run, SAU-183):**
> - **LiveKit cascade — NOW MEASURED LIVE, N=50 (FINAL for cascade-lower-bound).** Dev overwrote the provisional EA N=2 smoke with the full run: **TTFA p50 1628 / p95 2730 ms** (was 1966/3422 cold-start-inflated at N=2 — warmer at N=50 but the gap is structural, not warm-up), **mid-turn tool ✅** (22 tool calls / 100 turns, max dead-air 1 ms), transcript persisted (100 turns). **FAILS the ≤800 ms TTFA bar by ~3.4×.** Direct cascade Deepgram→OpenAI→Cartesia = the TTFA *lower bound* (Option-A `@livekit/agents` wrapper can only be slower), so cascade does not clear latency even at its best case. Cost ~$0.122 (est, 🟡 band). Barge-in not yet instrumented in the cascade adapter (—); not decision-critical given the latency miss. **Ready to feed the ADR-003 stopping rule.**
> - **Gemini Live — adapter bug FOUND + FIXED; now BLOCKED on Gemini BILLING (not a code defect).** Root cause confirmed (2026-06-07): model id `gemini-2.0-flash-live-001` is **not served on v1beta** for this key (WS close 1008 "not found … not supported for bidiGenerateContent"); ListModels → live set is the 2.5 native-audio family + `gemini-3.1-flash-live-preview`. **Fixed:** default model → `gemini-2.5-flash-native-audio-preview-12-2025` (env-overridable) **+** added close-frame error surfacing (the original adapter only logged via `ws.on('message')`, so a close-frame error showed up as a silent 0-event hang — now any abnormal close emits an `error` event). **New blocker:** with the correct model, the Gemini key returns **`429 RESOURCE_EXHAUSTED` — "Your prepayment credits are depleted"** on *even a basic `generateContent`* call (not just Live). The earlier "HTTP 200" validation was the free ListModels endpoint. **Unblock = board operator** must top up / swap to a funded Gemini billing project (within CFO $200 cap, approval [d20559b7](#)); then `npx tsx bench.ts --vendor gemini --turns 50 --realtime` is push-button (adapter now fails-fast with a clear diagnostic, so the next run either measures or names the exact blocker).
> - **Decision signal for the CTO:** both measured candidates miss the TTFA bar — OpenAI s2s p95 1905 ms, LiveKit cascade p95 2730 ms (its lower bound). Per the ADR-003 stopping rule, the only remaining candidate is Gemini Live, which is billing-blocked. If Gemini also misses latency once funded, the rule says **stop the vendor hunt and escalate the architectural fork** (revisit the 800 ms bar with the CPO; weigh WebRTC/edge or self-hosted).
> - Keys live in project-config env + `.env` (canonical). LiveKit/Deepgram/Cartesia/OpenAI all funded + working; only Gemini billing is depleted. Rotate/revoke after the spike.

## Benchmark table

| Vendor | Mode | TTFA p50 (ms) | TTFA p95 (ms) | Barge-in stop p95 (ms) | Mid-turn tool call? (max dead-air) | $/conv-min @ volume | Swap effort (LOC/hrs) | Pass? |
|---|---|---|---|---|---|---|---|---|
| OpenAI Realtime | s2s | 1288 | 1905 | 39 | yes (1 ms) | **$0.262 🔴 (measured)** | TBD | ❌✅✅ |
| Gemini Live | s2s | — | — | — | — | ~$0.042 (est) | TBD | deselected (board closed hunt; not measured) |
| LiveKit Agents | s2s | — | — | — | — | — | — | — |
| LiveKit Agents | cascade | 1628 | 2730 | — | yes (1 ms) | ~$0.122 (est) | TBD | ❌—✅ |
| Pipecat (optional) | — | — | — | — | — | — | — | — |

**Pass bars:** TTFA p95 ≤ 800 ms (p50 ≤ 500 target) · barge-in ≤ 300 ms · mid-turn tool call yes, dead-air ≤ 1.5 s · **cost within CFO envelope** — vendor 🟢 ≤ $0.09/conv-min · 🟡 $0.09–0.15 · 🔴 > $0.15 (fail) @ 60,000 conv-min/mo. Full bands, margin basis, and per-vendor reporting spec in [COST-ENVELOPE.md](./COST-ENVELOPE.md).

## Harness validation (proves the measurement pipeline before any spend)

The bench was run end-to-end against the deterministic `mock` adapter (`tsx bench.ts --vendor mock --turns 50`). This validates the *pipeline*, not a vendor — the mock's timings are configured, not measured, so these numbers prove the math is correct, not that any vendor passes.

| Check | Result |
|---|---|
| `tsc --noEmit` typecheck (interface + bench + 4 adapters + fixtures) | ✅ clean |
| Metric self-test (`harness.test.ts`, 8 assertions on known windows) | ✅ 8/8 pass |
| End-to-end bench, N=50 turns (8 tool, 7 barge-in) | ✅ ran, no errors |
| TTFA p50 / p95 computed | 208 / 440 ms (matches mock config — pipeline correct) |
| Barge-in stop p95 computed | 166 ms |
| Mid-turn tool dead-air (max) | 82 ms (agent keeps talking through tool call) |
| Transcript persisted (`stop()` → 100 turns, 8 tool calls) | ✅ |
| Raw per-turn JSON archived | ✅ `out/mock-report.json` |
| Real adapters gate on missing credentials with a clear blocker message | ✅ openai/gemini/livekit |
| Real speech fixture generated locally (macOS `say`, no spend) + harness streams it | ✅ `driver.wav` 328 s, per-turn offsets; bench `real audio streamed: true` |

> The metric self-test deliberately includes a *failing* case (a tool call with 1.8 s of dead-air → fails the ≤1.5 s bar) to confirm the pass/fail gating actually fails when it should — the harness will not rubber-stamp a bad vendor.

## End-to-end proof (acceptance)

- [x] **Live voice session ran end-to-end on a real vendor — OpenAI Realtime (`gpt-realtime`, GA WebSocket).** N=50 turns, real speech fixture.
- [x] **Transcript persisted from the live session** — `out/openai-report.json` (100 turns: 50 user + 50 agent, 6 tool calls).
- [x] Raw per-turn JSON archived in `./out/` (`openai-report.json`, `mock-report.json`).
- [x] Harness end-to-end proven (mock): live-shaped event stream → metrics → persisted transcript → archived JSON.

## Observations (OpenAI Realtime, measured 2026-06-06, N=50)

- **Latency — FAILS the bar, and not just because of VAD.** TTFA p50/p95 = **1288 / 1905 ms** (min 1036, max 2217). The measurement includes a 500 ms `server_vad` endpoint window by design (it's real perceived latency). Even subtracting the full 500 ms, net p95 ≈ **1405 ms** — still ~1.75× the 800 ms bar — so VAD-tuning alone cannot bring it under. Caveat: this is **WebSocket** transport from this host's region; production **WebRTC** + region pinning would shave RTT/jitter but is very unlikely to close a ~1100 ms gap. Latency was stable across the 50-turn session (no drift, no reconnects).
- **Barge-in — excellent.** p95 = **39 ms** (range 23–39 across all 7 barge-in turns). Server-VAD `interrupt_response` stops agent audio almost immediately; well inside the 300 ms bar.
- **Mid-turn tool calling — works.** 6 of 8 scripted pricing turns triggered `lookupPrice`; max dead-air **1 ms** (audio kept flowing around the call — no stall). Caveat: the bench's tool handler returns instantly, so dead-air is a floor, not a stress test of a slow tool. The 2 misses were the model answering pricing conversationally instead of calling the tool (terse-reply instruction may have suppressed it).
- **Cost — NOW MEASURED (SAU-197, 2026-06-07, usage-capture re-run).** `response.done.usage` is now captured and summed across the session; the `$/conv-min` is computed from **measured tokens × `gpt-realtime` published per-token rates** (not the rate card). See the "Measured cost" section below for the full token breakdown, rate table, 6-min projection, and prompt-caching split. **Headline: $0.262/conv-min (6-min projection, 🔴).** This is ~45% below the old rate-card estimate ($0.48) — prompt-caching covered **88.9%** of input tokens (−70.1% cost vs uncached) — but it still sits in the **🔴 (>$0.15) fail band**. OpenAI is already out on **latency**, so this firms the cost cell from estimate→measured without changing the disposition.
- **Operability.** One benign server error per barge-in turn (`Cancellation failed: no active response`) — our explicit `response.cancel` races the server's own VAD auto-interrupt; harmless (barge-in still measured cleanly via the cancelled `response.done`). No disconnects over 50 turns.

## Measured cost — OpenAI Realtime (SAU-197, live N=50 re-run, 2026-06-07)

> Feeds the **CFO Gate-1 unit-economics verdict** on [SAU-196](/SAU/issues/SAU-196). Computed from **measured tokens** captured via `response.done.usage` (93 samples summed over the session) × **published `gpt-realtime` per-token rates** — no rate-card estimate. Spend was de-minimis (~$1.01 for the session) within board spike approval `86482c32` / [COST-ENVELOPE.md](./COST-ENVELOPE.md) §3. Raw per-turn usage archived in `out/openai-report.json` (`transcript.usage.perTurn`, `report.measuredCost`).

**Rate table used** (USD per 1M tokens · model `gpt-realtime` server-confirmed · source: OpenAI published pricing, developers.openai.com/api/docs/pricing, fetched 2026-06-07):

| | Text in | Cached text in | Text out | Audio in | Cached audio in | Audio out |
|---|---:|---:|---:|---:|---:|---:|
| $/1M tok | 4.00 | 0.40 | 16.00 | 32.00 | 0.40 | 64.00 |

> Audio dominates (~99% of billed weight). gpt-realtime-2 differs only in text-output ($24 vs $16) — it would move the total <1%, so the cost number is robust to that ambiguity.

**Measured token usage (session totals, 93 response.done samples):**

| Bucket | Tokens | of which cached | uncached (billed full) |
|---|---:|---:|---:|
| Audio input | 77,661 | 66,368 | 11,293 |
| Text input | 82,009 | 75,520 | 6,489 |
| **Input total** | **159,670** | **141,888 (88.9%)** | **17,782 (11.1%)** |
| Audio output | 8,241 | — | 8,241 |
| Text output | 2,412 | — | 2,412 |

**Cost results:**

| Metric | Value |
|---|---|
| Session cost (as-run) | **$1.0101** over **4.07 min** / 50 turns (93 model responses incl. tool follow-ups + barge-in cancels) |
| **As-run $/conv-min** | **$0.248** |
| **6-min $/conv-min (projection w/ context accumulation)** | **$0.262** → **🔴** (>$0.15 fail band) |
| All-in $/conv-min (+15% loading, COST-ENVELOPE §2) | ~$0.301 |
| Implied monthly @ Base 60,000 conv-min/mo | ~$15,720/mo vendor (~$18,080 all-in) — over the $9,000/mo hard ceiling |
| **Prompt-caching savings** | **88.9% of input tokens cached → −70.1% session cost** vs all-uncached ($1.01 measured vs $3.38 counterfactual) |

- **Prompt-caching was ON** (Realtime API caches the growing conversation prefix automatically; no extra config). It is the reason the number is $0.26 and not ~$0.7–0.8/min — without it, OpenAI Realtime would be ~3.3× more expensive.
- **6-min projection method:** the per-turn cost series (93 samples) was least-squares-fit (`cost(i)=a+b·i`) and summed out to the turn count that fills 6 min at the observed cadence (~22.8 model responses/min → ~137 responses). The projection ($0.262) is only ~6% above the as-run figure ($0.248) **because caching damps the context-accumulation slope** — each new turn's *uncached* delta is just its fresh audio; the re-billed history is served from cache at $0.40/1M. Context accumulation is real but cheap under caching.
- **Structural floor — caching cannot rescue the band.** **Audio *output* is $0.1295/conv-min on its own — 52% of session cost — and is never cached** (only the input prefix is). That uncacheable output floor alone nearly hits the $0.15 ceiling, so no amount of additional prompt-caching or context management pulls OpenAI Realtime into 🟡/🟢: the gpt-realtime output-audio rate ($64/1M) sets the floor. This is the key durable finding for the CFO — the 🔴 is structural to the per-token rate card, not an artifact of an un-optimized run.
- **Verdict for Gate 1:** measured cost **confirms the 🔴 band** that the estimate flagged, but at roughly half the estimated magnitude ($0.262 vs $0.48). The CFO can now finalize the Gate-1 cost band on measured data, not the rate card. Disposition is unchanged — OpenAI was adopted on the end-to-end/latency basis with the cost gap accepted eyes-open (see Recommendation).
- **Latency note (transparency):** this cost re-run also re-sampled latency at **TTFA p50/p95 1410 / 2576 ms** (net-of-VAD 910 / 2076) — a second sample, higher than the canonical 2026-06-06 run (1288 / 1905, kept as the headline latency row above) but **the same FAIL verdict** (network/region variance on WebSocket from this host; well over the 800 ms bar either way). `out/openai-report.json` now holds this 2026-06-07 re-run's metrics + usage; barge-in (36 ms) and mid-turn tool (1 ms) re-confirmed ✅.

## Mini engine bench — `gpt-realtime-2.1-mini` vs premium (SAU-519, live N=50, 2026-09-21)

> **Go/no-go gate for Clinic Secretary pricing** ([SAU-519](/SAU/issues/SAU-519), spun out of [SAU-455](/SAU/issues/SAU-455) §packaging). Question: does mini hold the turn count and TTFA of the premium engine, so the 69.7% COGS reduction assumed by the price sheet is real? Same N=50 fixture, same harness, same host, only `OPENAI_REALTIME_MODEL` changed. Because the SAU-197 baseline is 3 months old and a different model version (`gpt-realtime`), a **same-day premium control on `gpt-realtime-2.1`** (the engine the price sheet names) was run back-to-back as the paired comparator. Raw archives: `out/openai-mini-report.json`, `out/openai-2.1-control-report.json` (+ `*-run.log`). Spend: ~$0.17 (mini) + ~$0.63 (control).

**Rate table used** (USD per 1M tokens · source: OpenAI published pricing, developers.openai.com/api/docs/pricing, fetched 2026-09-21):

| Model | Text in | Cached text in | Text out | Audio in | Cached audio in | Audio out |
|---|---:|---:|---:|---:|---:|---:|
| `gpt-realtime-2.1` | 4.00 | 0.40 | 24.00 | 32.00 | 0.40 | 64.00 |
| `gpt-realtime-2.1-mini` | 0.60 | 0.06 | 2.40 | 10.00 | 0.30 | 20.00 |

**Turn count + token profile (`response.done.usage`, session totals):**

| | SAU-197 baseline `gpt-realtime` (2026-06-07) | Control `gpt-realtime-2.1` (2026-09-21) | **Mini `gpt-realtime-2.1-mini` (2026-09-21)** | Mini vs control |
|---|---:|---:|---:|---:|
| Model responses (usage samples) / 50 fixture turns | 93 | 70 | **75** | **+7.1%** (vs baseline −19.4%) |
| Session wall-clock (min) | 4.07 | 4.12 | 4.39 | +6.3% |
| Tool calls (8 scripted tool turns) | 7 | 12 | 10 | — |
| Audio input tokens (cached) | 77,661 (66,368) | 37,481 (32,192) | 40,482 (36,672) | +8.0% |
| Text input tokens (cached) | 82,009 (75,520) | 65,003 (57,536) | 71,707 (64,832) | +10.3% |
| Input total · cached % | 159,670 · 88.9% | 102,484 · 87.6% | 112,189 · 90.5% | +9.5% |
| Audio output tokens | 8,241 | 5,207 | **4,952** | −4.9% |
| Text output tokens | 2,412 | 2,498 | 4,616 | +84.8% (cheap bucket: $2.40/1M) |
| Total tokens | 170,323 | 110,189 | 121,757 | +10.5% |
| Session cost (as-run) | $1.0101 | $0.6282 | **$0.1672** | **−73.4%** |
| As-run $/conv-min | $0.248 | $0.152 | **$0.038** | −75.0% |
| **6-min $/conv-min (projection)** | $0.262 🔴 | $0.138 🟡 | **$0.035 🟢** | **−74.3%** (vs baseline −86.5%) |

**Latency (TTFA gross = includes the 500 ms server-VAD window; net = −500 ms):**

| | Baseline `gpt-realtime` (06-07) | Control `gpt-realtime-2.1` | **Mini** | Mini vs control |
|---|---:|---:|---:|---:|
| TTFA p50 / p95 gross | 1410 / 2576 | 1506 / 1723 | **1744 / 2373** | +16% / **+38%** (vs baseline +24% / −8%) |
| TTFA p50 / p95 net-of-VAD | 910 / 2076 | 1006 / 1223 | 1244 / 1873 | |
| TTFA normal turns (n=35) p50 / p95 / max | 1371 / 1674 / 1902 | 1515 / 1720 / 2061 | 1744 / 2830 / **3794** | fatter tail |
| TTFA tool turns (n=8) p50 / p95 | 2097 / 3149 | 1387 / 1633 | 1605 / 2083 | |
| TTFA barge-in turns (n=7) p50 / p95 | 1377 / 1790 | 1676 / 1752 | 1665 / 1929 | |
| Barge-in stop p95 (bar ≤300) | 36 ms ✅ | 39 ms ✅ | **5 ms ✅** | |
| Mid-turn tool max dead-air (bar ≤1500) | 1 ms ✅ | 0 ms ✅ | 0 ms ✅ | |

**Reading against the pre-committed decision rule (SAU-519):**

- **Turn count: 🟢.** Mini needed **75 responses vs 70** for the same-day premium control (**+7.1%**, inside the +15% green line) and *fewer* than the stale June baseline (93). Mini does not "talk in circles" to complete the intake — it completes every scripted turn, all 8 tool turns fire `lookupPrice`, barge-in is cleaner than premium. Output *audio* (the expensive, uncacheable bucket) is 5% *lower* than premium; the extra tokens are text output at $2.40/1M.
- **COGS: the assumed reduction is conservative.** Measured **−74.3%** vs same-day premium (price sheet assumed −69.7%). Model cost is **$0.035/conv-min** at 6-min projection — deep inside 🟢 and ~3× under the $0.1075 all-in mini figure the packaging band used. Separately, note the *premium* engine is also cheaper than the June figure ($0.138 vs $0.262 — `2.1` is terser: 70 vs 93 responses, 5.2k vs 8.2k audio-out tokens); the SAU-455 premium column ($0.3217 all-in) is stale but stays 🟡/🔴 — it does not change the "premium is unsellable at 70% GM" conclusion.
- **TTFA: 🟡 — flag, not a fail.** The literal SAU-176 bar (p95 ≤ 800 ms) has never been met by *any* engine, including the one the board adopted (premium measured 1905 / 2576 / 1723 across three runs); read literally, the rule would fail the incumbent too. Against the incumbent-as-measured, mini's p95 (2373 ms) is **inside the envelope the board already accepted** (SAU-197: 2576 ms) but **+650 ms slower than premium measured the same day** (1723 ms), with a fatter tail on normal turns (max 3.8 s). For an inbound phone caller that tail is audible. It is a UX-mitigation item for the telephony bridge (early acknowledgement / filler utterance on `speech_stopped`, WebRTC + region pinning), not a pricing blocker — the same mitigation is needed on premium.
- **Tool-arg fidelity caveat:** mini passed `sku: "pro plan"` / `"PRO"` where premium passed `"pro-plan"` / `"pro-seat"`. Harmless against this mock, but a real booking tool should constrain args with enums / strict schemas rather than trusting free-text from mini.
- **Sample-size caveat:** one 50-turn session per engine. June→September premium drift (93→70 responses) shows model-version variance dwarfs session noise, which is why the same-day paired control is the comparator. If the CRO wants a confidence interval on the +7.1%, three sessions per engine ≈ $2.50 total.

**Net:** mini holds the turn count (+7.1%), beats the assumed COGS reduction (−74% vs −70%), passes barge-in and tool-calling, and lands TTFA inside the accepted premium envelope with a tail to mitigate in the bridge. The SAU-455 price sheet stands on the turn-count/COGS axis; TTFA is a 🟡 engineering flag routed to the bridge work ([SAU-525](/SAU/issues/SAU-525)), not a re-pricing input.

## Recommendation — DECIDED: OpenAI Realtime (board, 2026-06-07)

- **✅ Board decision `333a08e1` (2026-06-07): adopt OpenAI Realtime for the Slice-0 voice MVP; close the vendor hunt.** Recorded in [ADR-003 → "Board decision"](../../adr/ADR-003-realtime-voice-build-vs-buy.md) (Status: **Accepted**).
- **Measured landscape that informed it:**
  - **OpenAI Realtime (chosen)** — TTFA p50/p95 **1288 / 1905 ms** (over the 800 ms bar), barge-in **39 ms** ✅, mid-turn tool ✅, cost ~$0.48 est (🔴). The only vendor proven **end-to-end live, N=50, transcript persisted.**
  - **LiveKit cascade** — TTFA p50/p95 **1628 / 2730 ms** (fails ~3.4×; this is the cascade *lower bound*), tool ✅, cost ~$0.122 (🟡). Overturned the ADR's "cascade beats S2S latency" lean — cascade is the **slowest** option.
  - **Gemini Live** — **deselected before measurement** (board closed the hunt; SAU-190 funding cancelled). Adapter is live-ready if ever revisited.
- **The board accepted the latency/cost gap with eyes open** — ship the MVP on the one fully-proven vendor rather than spend further chasing a marginal latency win. The "what latency does reflective coaching actually need?" question moves to the **CPO product-latency review** as a *separate, non-blocking* track (it governs the long-term bar, not this MVP adoption).
- **Reversibility:** the `realtime-interface.ts` hard boundary keeps this swappable — a future bar change is a new adapter, zero changes elsewhere.
- **Follow-ups:** ~~measured-token cost (capture `response.done.usage`) before the production commitment~~ **DONE (SAU-197, 2026-06-07)** — see "Measured cost" section: $0.262/conv-min (6-min, 🔴), 88.9% cache hit. CFO to finalize the Gate-1 cost band on [SAU-196](/SAU/issues/SAU-196) from this measured data; CFO/CTO cost re-validation vs [COST-ENVELOPE.md](./COST-ENVELOPE.md) at the production-commitment gate.
