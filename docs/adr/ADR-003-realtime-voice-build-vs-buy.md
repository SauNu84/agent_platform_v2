# ADR-003 — Realtime voice conversation layer: build-vs-buy and vendor selection

- **Status:** **Accepted** (2026-06-07, board decision `333a08e1`) — **OpenAI Realtime** adopted for the Slice-0 voice MVP; the vendor hunt is closed. *Buy* was already decided; the Slice-0 measured spike (SAU-176) is complete (OpenAI + LiveKit cascade measured live, N=50). See **"Board decision"** below. The original "name a vendor only if it clears the bars" rule was overridden by an explicit board call to ship on OpenAI now and revisit later — recorded transparently below.
- **Date:** 2026-06-06
- **Author:** Enterprise Architect
- **Deciders:** CTO (vendor recommendation must be escalated per SAU-175), CFO (unit-economics sign-off)
- **Parent:** SAU-171 · **Issue:** SAU-175 · **Spike (blocker):** see linked child issue
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §5, §9
- **Related:** [ADR-005](ADR-005-multimodal-tool-protocol.md) (tool protocol rides on the chosen vendor's tool-calling)

## Context

The realtime multimodal conversation pipeline (speech-in → LLM-with-tools → speech-out, plus tone/expression input and barge-in) is **the single component that decides the project** (design §5, §9). Latency and quality define whether the product feels real; per-minute inference + STT/TTS cost defines unit economics. Building WebRTC transport, echo cancellation, and our own STT/TTS is out of scope and not our differentiation.

**Build-vs-buy is already settled in favor of BUY** (board-approved direction): we buy the realtime transport and build orchestration, tools, content, composition, and analytics on top. What remains is **which vendor** — and that must be grounded in measured numbers, not marketing.

## Decision (two parts)

### Part A — Buy the realtime transport (decided)
Buy the realtime conversation transport/runtime; build the orchestration + tool layer + the rest of the platform. **Rationale:** sub-300ms voice latency, barge-in, mid-turn tool calling, vision/tone, and graceful degradation are hard, undifferentiated, and actively maintained by specialist vendors; the reference product buys it too.

### Part B — Vendor selection (RESOLVED → **OpenAI Realtime**, board decision `333a08e1`, 2026-06-07)
> **Resolved:** the Slice-0 measured spike ran, the board selected **OpenAI Realtime** for the MVP, and the CTO signed off — see **["Board decision"](#-board-decision--adopt-openai-realtime-close-the-vendor-hunt-2026-06-07-decider-board)** and **"CTO acceptance sign-off"** below for the binding outcome. The text in this subsection is the *original pre-spike framing* and is **retained as the decision record**; the "provisional lean" below was **measured and overturned** (see the CTO thesis-correction: cascade was the *slowest* option, not the latency winner).

Evaluate **OpenAI Realtime API, Google Gemini Live, LiveKit Agents, and Pipecat** against the rubric below using **Slice-0 measured numbers**, then name one. **Provisional lean (to be confirmed/overturned by data): a framework that preserves portability (LiveKit Agents or Pipecat) wrapping a speech-to-speech model (gpt-realtime or Gemini Live), rather than coding directly against a single proprietary API.** Rationale: it satisfies the hard-boundary/swap-ability requirement *natively* (both frameworks already expose pluggable realtime models and a cascade path), decoupling our latency/cost bet from a single vendor's roadmap. **This lean is a hypothesis, not the decision.** *(Outcome: overturned by measurement — portability via cascade cost latency, and the hard interface boundary already buys reversibility without it.)*

### Hard interface boundary (decided, non-negotiable — design §5)
Regardless of vendor, the realtime layer sits behind a **stable internal interface** from day one:

```
startSession(scenario) → { events: AsyncIterable<SessionEvent>, sendAudio, registerTool, interrupt, stop() → Transcript }
```

The rest of the platform depends only on this interface — never on a vendor SDK type. Vendor swap = new adapter, zero changes elsewhere. Spike harness + full interface: `docs/spikes/slice-0-realtime-voice/`.

## Decision rubric (weights set now; scores filled by Slice-0)

> **Hard gates (pass/fail, before the weighted score even applies — added per CISO review of [ADR-004](ADR-004-coach-memory-model.md), see "Privacy & data-protection gate" below):** a candidate that cannot contractually guarantee **no-training-on-our-data** and a **signed Art. 28 DPA** is **disqualified regardless of its weighted score.** Privacy is a selection criterion, not a tiebreaker.

| Criterion | Weight | How measured (Slice-0) | Pass bar |
|---|---:|---|---|
| **Voice round-trip latency** (time-to-first-audio, p50/p95) | 28% | end-of-user-utterance → first agent audio frame, N≥50 turns | p95 ≤ 800 ms; p50 ≤ 500 ms target |
| **Mid-turn tool calling** | 18% | scripted scenario forces a tool call; does the model keep talking while the tool runs? | Yes, without dead air > 1.5 s |
| **Barge-in behavior** | 13% | user speaks during agent playback → time to agent stop | Clean stop ≤ 300 ms, no overrun |
| **Cost / conversation-minute @ projected volume** | 18% | measured vendor usage × published rates @ target volume | within unit-economics envelope (CFO): vendor 🟢 ≤ $0.09/conv-min · 🟡 $0.09–0.15 · 🔴 > $0.15 (fail), @ **60,000 conv-min/mo** Base. Bands + margin basis: [spike COST-ENVELOPE.md](../spikes/slice-0-realtime-voice/COST-ENVELOPE.md) |
| **Privacy & data protection** | 10% | score the gradable terms in the gate below (residency support, vendor retention posture, sub-processor count, self-host = audio stays in our trust boundary) | all **hard gates** cleared; residency-pinnable; zero/minimal vendor retention |
| **Lock-in / portability** | 8% | effort to swap behind the interface; OSS vs hosted | adapter-swappable; OSS self-host = bonus |
| **Operability** (degradation, observability, on-call) | 5% | reconnect behavior, error events, metrics surface | graceful degradation + usable telemetry |

*(Weights rebalanced from the original 30/20/15/20/10/5 to make room for the 10% privacy row without disturbing latency's dominance; sum = 100%.)*

### Privacy & data-protection gate (CISO-mandated — every candidate MUST clear before *real* user PII flows)

Set by the CISO privacy review of [ADR-004](ADR-004-CISO-privacy-review.md) §4. The **Slice-0 spike itself runs on synthetic/seed audio only — no real user PII to an un-DPA'd vendor.** A candidate must clear all of these before production PII:

1. **Signed DPA** with GDPR Art. 28 processor terms; **SCCs / UK IDTA** for any transfer outside an adequacy region.
2. **No training on our data** — contractual guarantee that audio/transcripts are never used to train/improve vendor models (the no-train / zero-retention tier). **Hard gate.**
3. **Zero / minimal vendor-side retention** — configure zero-retention and disable human abuse-monitoring review where offered; any unavoidable retention disclosed and within our ADR-004 windows.
4. **Data residency** — pin processing to our primary user region(s), or a documented lawful transfer mechanism. Capture region support in the scorecard.
5. **Sub-processor disclosure + flow-down** — vendor enumerates its sub-processors; we add them to our published list; no-train/retention/residency terms flow down.
6. **Security & breach SLA** — SOC 2 Type II or ISO 27001 + breach-notification ≤ 72h to us, in the DPA.

**Privacy weighting note:** a **self-hosted cascade** (LiveKit/Pipecat running our own STT/TTS/LLM calls) keeps audio inside our trust boundary except for the underlying model provider — a materially smaller PII surface and fewer sub-processors than a hosted S2S API. Score this as a genuine privacy advantage in the Privacy row (it is not merely a latency/cost trait).

## Published-data comparison (NOT decision-grade — desk research, mid-2026)

> Label key: **[V]** vendor-claimed/official-doc · **[3P]** third-party blog estimate (not controlled) · **[NPD]** not publicly documented. **No vendor publishes controlled p50/p95 voice round-trip latency; LiveKit explicitly declines to.** Every latency figure below is marketing or blog estimate — *this is exactly why Slice-0 must measure our own.*

| Dimension | OpenAI Realtime | Gemini Live | LiveKit Agents | Pipecat |
|---|---|---|---|---|
| Architecture | S2S only | Both (native audio + half-cascade) | Both (cascade + pluggable S2S) | Both (cascade + S2S) |
| First-audio latency | ~500 ms [3P]; no p50/p95 [NPD] | sub-800 ms [3P]; spikes reported; no p50/p95 [NPD] | declines to publish [V]; ~0.45–1.7 s [3P] | ~0.6–1 s [3P]; no p50/p95 [NPD] |
| Barge-in | Yes, server VAD [V] | Yes, VAD + `interrupted` event [V] | Yes, turn detection + interruption [V] | Yes, Silero VAD + SmartTurn [V] |
| Mid-response tool call | **Yes, async native** (gpt-realtime) [V] | **Yes**, `behavior: NON_BLOCKING` [V] | Model-dependent [V] | Model-dependent [V] |
| Cost/min (active audio) | ~$0.10 floor; $0.18–0.46 typical uncached [V+3P] | ~$0.02 [V] | ~$0.05–0.18 blended + inference passthrough [V+3P] | infra + provider only; framework free (BSD-2) [V] |
| Self-host / lock-in | None / high | None / high | OSS self-host / **low** | OSS self-host / **lowest** |

**Cartesia** (used by the reference product) is a cascade *component* (Sonic TTS sub-90 ms [V]; Ink STT), not an orchestrator — pairs under LiveKit/Pipecat if we run a cascade. Keep as a TTS/STT option, not a top-level candidate.

Sources: OpenAI pricing/`gpt-realtime` async tools (developers.openai.com, openai.com/index/introducing-gpt-realtime); Gemini Live capabilities + pricing (ai.google.dev/gemini-api/docs/live-api, /pricing); LiveKit docs + pricing + latency guide (docs.livekit.io/agents, livekit.com/pricing, livekit.com/blog/understand-and-improve-agent-latency); Pipecat repo (github.com/pipecat-ai/pipecat); Cartesia (cartesia.ai/sonic, /pricing).

## Measured data — TO BE FILLED BY SLICE-0 (blocks acceptance)

| Vendor | TTFA p50 | TTFA p95 | Barge-in stop | Mid-turn tool call | $/conv-min @ vol | Privacy gate (DPA / no-train / residency / retention) | Swap effort | Score |
|---|---|---|---|---|---|---|---|---|
| OpenAI Realtime | **1288 ms** ❌ | **1905 ms** ❌ | **39 ms** ✅ | **yes** ✅ (6/8 turns; ~0 ms dead-air) | ~$0.48 (est, 🔴) | TBD | adapter ~180 LOC / ~1 day | **fails latency gate** |
| Gemini Live | — | — | — | — | ~$0.042 (est, 🟢) | TBD | adapter live-ready | **deselected — not measured** (board closed the hunt before funding; [SAU-190](#) cancelled) |
| LiveKit Agents (cascade) | **1628 ms** ❌ | **2730 ms** ❌ | meas. | **yes** ✅ (22 calls; ~1 ms dead-air) | ~$0.122 (est, 🟡) | TBD | adapter ~direct cascade | **fails latency gate (lower bound)** |
| Pipecat | — | — | — | — | — | — | — | — (not measured) |

> **Privacy gate column:** record pass/fail on each hard gate (DPA, no-train) and the gradable terms (residency, retention, sub-processors). A vendor failing a hard gate is disqualified regardless of the weighted Score.
>
> **OpenAI Realtime — measured 2026-06-06 (N=50, live `gpt-realtime` GA over WebSocket, fixed speech fixture).** TTFA **p50 1288 / p95 1905 ms** (min 1036) — **fails the ≤800 ms bar**; net of the 500 ms server-VAD endpoint, p95 still ≈ 1405 ms, so VAD-tuning can't rescue it (WebRTC + region pinning might shave RTT but not a ~1100 ms gap). Barge-in **39 ms p95** (excellent). Mid-turn tool: kept talking, ~0 ms dead-air. Cost is rate-card **estimate** (measured-token cost is a follow-up; moot if latency disqualifies). Raw: `docs/spikes/slice-0-realtime-voice/out/openai-report.json`. **Gemini/LiveKit unmeasured — keys not provisioned.**

**Recommended vendor: OpenAI Realtime — board-selected for the MVP (2026-06-07, decision `333a08e1`).** See **"Board decision"** below. The board adopted OpenAI with eyes open on the measured latency/cost gap and closed the vendor hunt (Gemini deselected before measurement). The decisive-stopping-rule fork (revisit the 800 ms product bar with the CPO) continues as a *separate, non-blocking* track — it refines the long-term bar, not the MVP vendor.

### CTO decision on the first measured result (2026-06-06, decider: CTO)

The first measured vendor came back and I'm ruling on it now, applying the pre-commitment above.

- **OpenAI Realtime (hosted S2S over WS) is DISQUALIFIED for the production recommendation.** It fails *two* hard pass-bars: TTFA p95 1905 ms (~1405 ms net of server-VAD vs ≤800 ms — a ~1100 ms inference+TTS gap WebRTC/region-pinning cannot close) **and** cost ~$0.48/conv-min (🔴, ~5× the $0.09 target / ~3× the $0.15 ceiling, even as a rate-card estimate). Per my rule, a 🔴 pass-bar fail is a disqualifier *before* scoring. Its excellent barge-in (39 ms) and zero-dead-air tool-calling are noted as a reference point and a possible fallback **only** if every alternative also fails *and* we consciously relax the bar — not as a live recommendation.
- **Decision: complete the comparison (option A).** I will **not** name a vendor on one failed data point — ranking "measured survivors" with zero survivors, or naming LiveKit unmeasured, would be the exact vibes-over-numbers failure this ADR exists to prevent. Provision **Gemini Live** (native audio, ~$0.02 published — the cost frontrunner) and **LiveKit** (cascade mode the priority: regional media + tunable endpointing is the most plausible way to beat OpenAI's latency) and measure both, N≥50, same fixture.
- **Decisive stopping rule (prevents an open-ended "measure more vendors" loop):**
  1. If Gemini **or** LiveKit clears TTFA p95 ≤ 800 ms with barge-in ≤ 300 ms, mid-turn tool OK, and cost within the CFO envelope → that is the recommendation (rank by weighted score if both pass). Same-heartbeat sign-off.
  2. If **both** also miss the latency gate over their best transport → **stop measuring vendors.** That is a material architectural finding: no hosted realtime option clears 800 ms at our cost point. Escalate the fork rather than grind on — (a) revisit the 800 ms bar with the **CPO** (is sub-800 ms the real product requirement for a coach, or is ~1.2 s acceptable?), and (b) evaluate whether WebRTC/edge transport across the board, or a self-hosted cascade, changes the picture. A WebRTC re-test of OpenAI is deferred until/unless transport becomes the deciding variable — it won't close a ~1100 ms gap, so it's low-value now.

This ADR stays **Proposed.** Critical-path blocker is now **board-operator provisioning of the Gemini + LiveKit (+ Cartesia for cascade) keys** ([SAU-182](#)) — the board's "OpenAI first, others later" deferral is now void because OpenAI failed and the decision cannot be made without a comparison.

### CTO update — second measured result + thesis correction (2026-06-07, decider: CTO)

The comparison's first new data point landed and it overturns the ADR's original lean.

- **LiveKit cascade is measured live (N=50): TTFA p50/p95 = 1628 / 2730 ms — fails the ≤800 ms bar by ~3.4×.** Mid-turn tool-calling is clean (22 calls, ~1 ms dead-air); cost ~$0.122/conv-min (🟡). Crucially this is the cascade **lower bound** — direct Deepgram→OpenAI→Cartesia; the heavier `@livekit/agents` Option-A wrapper can only be slower.
- **Thesis correction (on the record):** the ADR's provisional lean — *"a framework cascade with regional media + tunable endpointing is the most plausible way to beat hosted-S2S latency"* — is **empirically dead.** Cascade is not the latency winner; it is the **slowest** option measured, ~825 ms worse at p95 than OpenAI's own S2S. Chaining STT→LLM→TTS stacks each stage's first-token latency; that structurally outweighs any media-transport saving. This is exactly why the spike measures instead of leaning. Portability via cascade is no longer worth pursuing on latency grounds.
- **Two of three candidates now disqualified on latency** (OpenAI 1905 ms, cascade 2730 ms), both by large margins, and the gap is in model inference + TTS first-frame — **not** transport or VAD tuning (net-of-VAD both still miss by > 600 / > 1400 ms). **Gemini Live (native-audio S2S, cheapest at ~$0.042 🟢) is the last candidate** before the stopping rule's architectural-fork branch. Its adapter bug is fixed; it is blocked only on funding a billing-enabled project ([SAU-190](#) / approval `3295883e`, within the CFO $200 cap).
- **The product-bar conversation is coming regardless of Gemini's result.** Even the *best plausible* outcome — Gemini clears the 800 ms **pass bar** — almost certainly still misses the **p50 ≤ 500 ms target** that the rubric calls the "feels real" line (OpenAI's own native S2S sat at p50 1288 ms). So whether Gemini passes or fails, the CPO and I owe a deliberate ruling on **what realtime latency the coaching product actually requires** (sub-800 ms "conversational," or is ~1.2–1.5 s acceptable for a reflective coach?). I will open that fork to the **CPO** the instant Gemini's number lands — pass *or* fail — with the complete three-vendor latency/cost landscape in hand, rather than pre-deciding it now on two data points.

### ✅ Board decision — adopt OpenAI Realtime, close the vendor hunt (2026-06-07, decider: Board)

**The board ruled directly, overriding the "measure Gemini before deciding" path.** Board accepted confirmation `333a08e1` (local-board, 2026-06-07): **adopt OpenAI Realtime for the Slice-0 voice MVP and stop the vendor hunt.** Gemini Live is **deselected before measurement** ([SAU-190](#) funding cancelled, approval `3295883e` superseded — no spend).

- **What the board accepted, eyes open:** OpenAI's measured **TTFA ~1.3 s p50 / 1.9 s p95** (over the 800 ms bar) and **~$0.48/conv-min** estimate (≈11× the 🟢 target) — explicitly informed of the latency and cost gaps. The board's call is to **ship the MVP now on the one fully-proven, end-to-end vendor** (live N=50, transcript persisted, excellent barge-in 39 ms, working mid-turn tools) rather than spend further to measure the last candidate.
- **Why this is defensible on the numbers:** the comparison already produced a decision-grade finding — **no measured option cleared 800 ms**, and the two measured (OpenAI S2S 1905 ms, LiveKit cascade 2730 ms) showed the gap is **inference+TTS**, not transport/VAD. Gemini, even at best, was projected to clear the *pass bar* but miss the *p50 target*. So the board chose the proven path over a marginal latency hunt, and folded the "is sub-800 ms actually required?" question into the **CPO product-latency review** (now a separate, non-blocking track — the board accepted the current latency for the MVP; the CPO review governs the longer-term bar, not this adoption).
- **Consequence for the hard-interface boundary (design §5):** adopting OpenAI does **not** re-introduce lock-in — the `realtime-interface.ts` boundary keeps the choice reversible; if the CPO review later tightens the bar, swapping is a new adapter, zero changes elsewhere. The OpenAI adapter, harness, fixture, and cost envelope are all committed under `docs/spikes/slice-0-realtime-voice/`.
- **Status:** ADR-003 → **Accepted** on this board decision. Cost re-validation against the production envelope ([COST-ENVELOPE.md](../spikes/slice-0-realtime-voice/COST-ENVELOPE.md)) remains a CFO/CTO follow-up before the production commitment, but does not gate MVP adoption.

### CTO acceptance sign-off (2026-06-07, decider: CTO)

I accept the board's selection of **OpenAI Realtime for the Slice-0 voice MVP** and close the vendor hunt. My earlier sign-off pre-commitment below would have *disqualified* OpenAI on two pass-bar fails (TTFA p95 1905 ms; cost ~$0.48 🔴) — the board has consciously overridden that engineering gate for the MVP, and I am recording that override transparently rather than papering over it. Three things are on the record so this does not read as a settled "good" number later:

- **Caveat — the chosen vendor misses the original latency aspiration, by design.** OpenAI's measured TTFA is **p50 ~1288 ms / p95 ~1905 ms**, against this ADR's own bars of **p95 ≤ 800 ms / p50 ≤ 500 ms "feels-real" target**. The MVP ships at ~2.4× the pass bar and ~2.6× the p50 target. This is a **deliberate board MVP trade** (ship now on the one fully-proven end-to-end vendor), **not** a finding that ~1.3 s clears the product bar. The "what latency does a reflective-coaching product actually require?" question is **not closed** — it moves to the CPO product-latency review (separate, non-blocking).
- **Cost is the scale lever, not the MVP blocker.** ~$0.48/conv-min is fine for an MVP/spike but ~11× the 🟢 target and ~3× the 🔴 ceiling; the production commitment ($5k–27k/mo band) must be re-validated against [COST-ENVELOPE.md](../spikes/slice-0-realtime-voice/COST-ENVELOPE.md) with measured-token cost (CFO/CTO follow-up) **before** we commit at volume.
- **Reversibility is intact and is the exit.** The `realtime-interface.ts` boundary keeps this a Year-1 bet, not a lock-in: swap = new adapter, zero changes elsewhere. The **auto-reopen triggers** in the sign-off pre-commitment below stand for production — measured $/conv-min > 20% over envelope (trailing 4 wks), TTFA p95 regression, or any hard privacy-gate breach. LiveKit cascade is the only other measured option (slower + dearer), so the real fallbacks if the CPO bar tightens are Gemini (unmeasured, cheapest) or a WebRTC/edge re-test — pre-vetted, not pre-built.

**Privacy gate:** the Slice-0 spike ran on synthetic/seed audio only, so OpenAI's DPA / no-train / residency / retention terms are **not yet cleared for production PII** — that paperwork is a hard gate that must close before real user audio flows (see the CISO privacy gate above). Tracked as a production-readiness follow-up, does not gate MVP build on synthetic audio.

With this recorded, SAU-176 (measured spike → vendor decision) is **complete** and closed; SAU-175 (formalize the architecture decision) unblocks for the EA.

### Slice-0 execution status (SAU-176, updated 2026-06-06)

The benchmark **harness is built, runnable, and self-validated end-to-end** — `docs/spikes/slice-0-realtime-voice/` is now an executable workspace, not a skeleton:

- `bench.ts` fully implemented (event buffering/windowing, per-turn metric extraction, transcript persistence, raw-JSON archive, RESULTS.md row upsert). Metric math is pure and unit-tested (`harness.test.ts`, 8/8 pass incl. a deliberate fail case so the pass-bar gating can't rubber-stamp a bad vendor).
- All four adapters implement the hard interface and **typecheck clean**. The three real adapters (`openai`, `gemini`, `livekit`) carry full server-event → `SessionEvent` translation, tool wiring, and barge-in; only the live socket is gated on credentials.
- Proven end-to-end against a deterministic `mock` adapter (N=50; 8 tool + 7 barge-in turns): live-shaped event stream → TTFA/barge-in/dead-air metrics → **persisted transcript** → archived JSON. The mock's numbers validate the *pipeline*, not a vendor.

**The vendor table above stays empty until the live run** — these must be measured numbers, not estimates. The live run is now strictly gated on (owners in the SAU-176 escalation):
1. **Paid vendor credentials + pending spike-spend approval** (EA) — OpenAI / Google / LiveKit (+ Cartesia/STT/LLM for cascade mode). The *measurement* spend is de-minimis (low tens of dollars, one-time); a board approval is in flight (`86482c32`) and **CFO endorses it at its requested bound**. The board scrutiny that matters is the **production** commitment ($5k–27k/mo, see CFO envelope), to be decided *with the measured data in hand*. See [COST-ENVELOPE.md §3](../spikes/slice-0-realtime-voice/COST-ENVELOPE.md).
2. **A WebRTC host app** to run sessions against (does not exist in this repo).
3. **A real speech `driver.wav`** that elicits the scripted behavior (committed fixture is a placeholder tone — fine for the mock only).
4. ~~**CFO-set projected volume** for the cost column~~ → **DONE (CFO, 2026-06-06):** Base **60,000 conv-min/mo** + cost-pass envelope ratified, [COST-ENVELOPE.md](../spikes/slice-0-realtime-voice/COST-ENVELOPE.md). One open dependency: confirm the **$0.60/conv-min monetization assumption** with CEO/CRO (formula provided so the bands auto-adjust).
5. Per the privacy gate above, capture each vendor's DPA / no-train / residency / retention terms during the run (a hard-gate failure disqualifies regardless of Score).

~~ADR-003 remains **Proposed**; it advances only after the table is filled from live runs and the CTO signs off.~~ **Superseded 2026-06-07:** the live runs filled OpenAI + LiveKit-cascade rows (N=50), the board selected OpenAI, and the CTO signed off above — ADR-003 is now **Accepted**. (Items 1–5 here are the original pre-run gate list, kept for history.)

## CTO sign-off pre-commitment (decider: CTO, 2026-06-06)

So I am not the *next* bottleneck after credentials land, I am pre-committing — as the named decider — the deterministic criteria that earn my sign-off. When the measured table is filled, the recommendation should map mechanically onto the rules below; if it does, expect same-heartbeat approval.

**Decision order (applied strictly in sequence):**

1. **Hard privacy gates are disqualifiers, not factors.** Any vendor that cannot produce a signed Art. 28 DPA *and* a contractual no-training-on-our-data guarantee is **out — regardless of weighted score.** Confirmed: privacy is a gate, not a tiebreaker. The Slice-0 run uses synthetic/seed audio only, so missing paperwork doesn't block *measuring* a vendor — but it blocks *recommending* one for production.
2. **Pass-bar fails are disqualifiers.** Any 🔴 on a pass bar removes the vendor: TTFA p95 > 800 ms · barge-in > 300 ms · mid-turn dead-air > 1.5 s · cost > $0.15/conv-min (CFO 🔴, [COST-ENVELOPE.md](../spikes/slice-0-realtime-voice/COST-ENVELOPE.md)). A 🟡 cost survives **only** if the vendor wins decisively on latency + privacy (per the CFO envelope's own rule).
3. **Among survivors, the weighted score ranks them.** I sign off the top weighted score by default.

**Portability posture (resolves the ADR's "provisional lean" — this is the part that needs a decider, not a formula):** the hard interface boundary already makes the vendor choice *structurally reversible* (swap = new adapter, zero changes elsewhere). Portability is therefore **already bought** by the architecture. I will **not** pay a material latency or cost penalty for *additional* framework-level portability. Concretely:

- If a hosted S2S vendor (OpenAI Realtime / Gemini Live) wins **decisively** — defined as a weighted-score lead ≥ 5 points **or** a full pass-tier better on TTFA p95 — its proprietary lock-in is acceptable, because the adapter makes a wrong pick recoverable, not fatal. I take the winner.
- The framework option's portability bonus (8% row) **breaks ties; it does not overturn a clear latency/cost/privacy win.** The provisional lean toward LiveKit/Pipecat stands only if the data shows latency/cost parity with the best S2S.
- Where a framework runs in **cascade mode**, weigh its measured privacy advantage (audio stays in our trust boundary, fewer sub-processors) per the Privacy row — that is a genuine factor, not a tiebreaker, and can be what makes "decisive" land in its favor.

**What I require in hand to sign:** filled RESULTS.md table (measured, N≥50, ≥1 vendor proven end-to-end with a *persisted* transcript) · cost column at Base 60k conv-min/mo with context-accumulation noted (not active-audio-only) · per-vendor privacy-gate column · a named recommendation with runner-up + an explicit switch trigger · **CFO co-sign on the cost row.**

**Reversibility clause (the bet's exit):** I accept the recommendation as a *Year-1 bet*, not a permanent commitment, precisely because the boundary makes it reversible. Auto re-open this ADR if, in production: measured $/conv-min drifts > 20% above the CFO envelope over a trailing 4 weeks, **or** TTFA p95 regresses past 800 ms over a trailing 4 weeks, **or** a hard privacy-gate term is breached. The runner-up named in RESULTS.md is the pre-vetted fallback.

## Consequences

**Positive:** the hard interface boundary makes the vendor choice *reversible* — the most dangerous risk (design §9) is de-risked by being swap-able, so a wrong initial pick is recoverable, not fatal. Buying avoids building/maintaining WebRTC + STT/TTS.

**Negative / trade-offs:** a hosted S2S vendor (OpenAI/Gemini) means no self-hosting and proprietary protocol lock-in (mitigated by the adapter). A framework (LiveKit/Pipecat) adds an orchestration layer we operate, but buys portability and a cascade fallback. Cost compounds with conversation length on all token-billed S2S models — unit economics must be validated at *realistic* conversation length, not active-audio-only.

## Alternatives considered

1. **Build the realtime stack ourselves.** Rejected (Part A) — undifferentiated, high-risk, slow; board-approved buy.
2. **Code directly against one proprietary S2S API (no framework).** Possible if Slice-0 shows a single vendor dominates latency/cost; cost is reduced portability. Kept open — the rubric decides.
3. **Cascade-only (LiveKit/Pipecat + Cartesia + LLM).** More control and component-swappability, typically higher latency than native S2S. The frameworks let us A/B cascade vs S2S behind the same interface — Slice-0 should measure both modes.

## Production-readiness gates (carry-forward — NOT MVP-build blockers)

The board adopted OpenAI Realtime for the MVP with eyes open. The following three gates are **consolidated here from the scattered notes above** (per the CTO's 2026-06-07 close-out direction) so they survive into the SAU-171 build plan. They do **not** block the MVP build on synthetic/seed audio, but each **must** be converted into a first-class blocker on the relevant Slice when the build plan is written.

| # | Gate | Owner | Must close before | Reference |
|---|---|---|---|---|
| 1 | **Measured-token cost re-validation** vs the production envelope (replace the ~$0.48 rate-card estimate with measured `response.done.usage` cost at realistic conversation length) | CFO / CTO | committing realtime voice **at volume** (the $5k–27k/mo band) | [COST-ENVELOPE.md](../spikes/slice-0-realtime-voice/COST-ENVELOPE.md), Consequences above |
| 2 | **OpenAI DPA / no-train / residency / retention** hard privacy gate (Art. 28 DPA signed; no-training-on-our-data; residency + retention terms) | CISO | **any real user PII / audio** flows to OpenAI | "Privacy & data-protection gate" §, ADR-004 |
| 3 | **CPO product-latency review** — set the long-term perceived-responsiveness bar (MVP ships at p50 ~1.3 s / p95 ~1.9 s vs the ≤500/≤800 ms engineering bars; is that the product bar or a temporary trade?) | CPO | the post-MVP latency commitment (separate, non-blocking track) | board decision §, Slice-0 measured table |

**Reversibility note:** the stable `startSession` adapter boundary keeps OpenAI swappable — if gate 1 or 3 fails the long-term bar, switching the realtime vendor is a new adapter, not a platform rewrite. This is the de-risk that makes the MVP override safe.
