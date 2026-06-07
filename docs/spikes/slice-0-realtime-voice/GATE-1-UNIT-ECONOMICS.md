# Gate 1 — OpenAI Realtime Unit-Economics Re-Validation (CFO verdict — FINAL, measured)

- **Owner:** CFO · **Date:** 2026-06-07 · **Issue:** [SAU-196](/SAU/issues/SAU-196) · **Parent:** [SAU-193](/SAU/issues/SAU-193) · **Source:** ADR-003 board decision `333a08e1`
- **Verdict: 🔴 RED — fails the production cost gate.** Now on **measured tokens** (not the rate card), via [SAU-197](/SAU/issues/SAU-197). The band is **structural**, not a measurement artifact.

## TL;DR (what changed from the pre-measurement draft)
- The capture gap is **closed**: [SAU-197](/SAU/issues/SAU-197) added `response.done.usage` reading, threaded it through the transcript/report, and re-ran live N=50 on `gpt-realtime`. Gate 1 now rests on **measured tokens × published per-token rates**, not the rate-card estimate.
- **Measured 6-min `$/conv-min` = $0.262 (🔴).** That is **1.75× the $0.15 hard ceiling** and **2.91× the $0.09 target** — but **~45% below the old rate-card estimate of $0.48.** The estimate was directionally right (RED) and quantitatively pessimistic by ~2×.
- **Prompt-caching is already ON and doing real work:** 88.9% of input tokens served from cache → **−70.1% session cost** vs all-uncached ($1.01 measured vs $3.38 counterfactual). This is *why* the measured number halved the estimate.
- **Caching still cannot rescue the band — and now we can prove why with measured data.** Audio *output* is **$0.1295/conv-min on its own = 52% of session cost = 86% of the entire $0.15 ceiling**, and output audio is **never cacheable**. The uncacheable output floor alone nearly hits the ceiling, so no further caching/context-management gets OpenAI Realtime into 🟡/🟢. The 🔴 is structural to the `gpt-realtime` rate card ($64/1M output audio), not an un-optimized run.
- OpenAI is **also out on latency** (TTFA p95 1905 ms vs 800 ms bar) — a gap the board accepted eyes-open for the MVP. So measured cost is **confirmatory for the MVP, decisive for the production commitment** (ongoing 60k+ conv-min/mo).

## Measured cost (the Gate-1 number)
Source: `out/openai-report.json` → `report.measuredCost` (93 `response.done.usage` samples summed) and `transcript.usage.perTurn`. Independently re-derived by CFO from token totals × published rates — ties to **$1.0101** to the cent.

**Rate table** (USD / 1M tokens, model `gpt-realtime`, OpenAI published pricing fetched 2026-06-07):

| | Text in | Cached text in | Text out | Audio in | Cached audio in | Audio out |
|---|---:|---:|---:|---:|---:|---:|
| $/1M | 4.00 | 0.40 | 16.00 | 32.00 | 0.40 | **64.00** |

**Measured token usage (session totals):**

| Bucket | Tokens | of which cached | uncached (billed full) |
|---|---:|---:|---:|
| Audio input | 77,661 | 66,368 | 11,293 |
| Text input | 82,009 | 75,520 | 6,489 |
| **Input total** | **159,670** | **141,888 (88.9%)** | **17,782 (11.1%)** |
| Audio output | 8,241 | — (never cacheable) | 8,241 |
| Text output | 2,412 | — | 2,412 |

**Cost results:**

| Metric | Value | Band |
|---|---|---|
| Session cost (as-run) | $1.0101 over 4.07 min / 50 turns (93 model responses) | — |
| As-run $/conv-min | $0.248 | 🔴 |
| **6-min $/conv-min (projection w/ context accumulation)** | **$0.262** | **🔴** |
| All-in $/conv-min (+15% loading, COST-ENVELOPE §2) | $0.302 | 🔴 |
| **Cost of the uncacheable audio-output line alone** | **$0.1295/conv-min** | (86% of the $0.15 ceiling by itself) |
| Prompt-caching savings | 88.9% input cached → −70.1% session cost | — |

**6-min projection method:** per-turn cost series (93 samples) least-squares-fit `cost(i)=a+b·i`, summed to the turn count filling 6 min at observed cadence (~22.8 responses/min → ~137 responses). Projection ($0.262) is only ~6% above as-run ($0.248) because **caching damps the context-accumulation slope** — each new turn's *uncached* delta is just its fresh audio; re-billed history is served from cache at $0.40/1M. Context accumulation is real but cheap under caching.

## Production-burn projection (CFO envelope, COST-ENVELOPE.md §1–2) — on MEASURED $0.262/min

| Scenario | Conv-min/mo | Vendor $/mo | All-in (+15%) $/mo | vs Target ($5,400/mo) | vs Ceiling ($9,000/mo) |
|---|---:|---:|---:|---:|---:|
| Bear (pilot) | 12,000 | $3,148 | $3,620 | 0.58× | 0.35× |
| **Base (Year-1)** | **60,000** | **$15,739** | **$18,100** | **2.91×** | **1.75×** |
| Bull (scale) | 300,000 | $78,694 | $90,500 | 14.6× | 8.7× |

- Base annualized: **~$188.9k/yr vendor (~$217.2k all-in).** (vs the rate-card estimate's ~$345.6k — measured roughly halves the projected production burn.)
- **Reduction required** from the measured figure to clear the **ceiling: 42.8%**; to hit the **target: 65.7%.** (Estimate-era figures were 69% / 81% — measured makes the gap smaller but still unbridgeable in-vendor, see below.)
- **Note on the per-min band vs monthly $:** at **Bear/pilot** volume the *monthly* burn is under both the target and ceiling $/mo — but the **band is per-conv-min and volume-independent**, so the unit-economics verdict is 🔴 at every scale. Pilot affordability ≠ unit-economics pass.

## Why in-vendor optimization cannot close the gap (now measured, not asserted)
Prompt-caching discounts **cached *input* only**. The measured bill is dominated by:
- **Audio output ($64/1M, never cacheable): $0.1295/min — 52% of cost.** Generated fresh every turn. This single line is 86% of the $0.15 ceiling.
- **Fresh per-turn user audio input — not cacheable.**
- Only re-sent prior context (system prompt, tool defs, history) is cache-eligible — and it **already is** (88.9% hit). The caching upside is **spent**, not latent.

A further 42.8% cut is therefore not reachable in-vendor: the largest line is uncacheable and the cache is already saturated. Context truncation/summarization trims input re-billing that is *already* mostly $0.40/1M cached — marginal. **The 🔴 is a property of the `gpt-realtime` output-audio rate card.**

## Verdict and named paths
**🔴 RED — OpenAI Realtime fails the production cost gate (measured $0.262/conv-min, 1.75× ceiling) and cannot be brought into the envelope by in-vendor optimization.**

1. **MVP disposition — unchanged, eyes-open.** The board adopted OpenAI for the Slice-0 MVP (`333a08e1`) accepting the latency gap; the measured cost confirms the cost gap is real but ~half the feared magnitude. At **pilot/Bear volume the monthly burn (~$3.6k all-in) is affordable**, so the MVP launch is not cost-blocked. Gate 1 does **not** reverse the MVP decision.
2. **Board cost decision — REQUIRED before the production commitment (this is the live action).** Scaling to **Base 60k conv-min/mo = ~$15.7k/mo vendor (~$18.1k all-in, ~$217k/yr)** at 1.75× the unit-economics ceiling is a **separate, larger commitment** than the MVP. It must be an explicit board decision made *with this measured number in hand*, against confirmed product monetization (the $0.60/conv-min in COST-ENVELOPE §2 is still an **assumption** — CEO/CRO must confirm `P`; the GM math and bands move by formula if it changes).
3. **The only path that actually reaches the envelope is the ADR-003 reversibility clause** (swap vendor via the `realtime-interface.ts` hard boundary — a new adapter, zero changes elsewhere):
   - **Gemini Live ~$0.042/min (🟢)** — clears cost with headroom; billing-blocked + deselected (board closed the hunt). Adapter is live-ready if revisited.
   - **LiveKit cascade ~$0.122/min (🟡)** — clears the watch band on cost but fails latency ~3.4× (TTFA p95 2730 ms).
   - On **cost alone**, only a vendor change clears the bar — at a latency cost the board already weighed for the MVP.

## Gate-1 acceptance — MET
- [x] **Measured $/conv-min recorded with method** — $0.262 (6-min), measured tokens × published rates, method documented above + in RESULTS.md "Measured cost" + `out/openai-report.json`.
- [x] **Compared to $0.09 target / $0.15 ceiling** — 2.91× target, 1.75× ceiling.
- [x] **GREEN/AMBER/RED verdict** — **🔴 RED** (structural).
- [x] **Named cost-reduction / board-decision path (since not GREEN)** — board production cost decision (path 2) + ADR-003 reversibility / vendor swap (path 3); in-vendor optimization ruled out with measured evidence.

**Gate 1 of 2 on the OpenAI Realtime production commitment is COMPLETE.** It feeds [SAU-193](/SAU/issues/SAU-193): the production commitment carries a **known, board-decidable 🔴 cost gap (1.75× ceiling)** alongside Gate 2 (CISO privacy/DPA). Neither blocks the MVP; both gate the production scale-up.
