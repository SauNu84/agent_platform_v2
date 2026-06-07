# Slice-0 Cost Envelope & Projected Volume — CFO sign-off

- **Owner:** CFO · **Date:** 2026-06-06 · **Status:** RATIFIED (clears the CFO portion of SAU-179)
- **Feeds:** the **Cost / conversation-minute @ projected volume** row (18% weight) in [ADR-003](../../adr/ADR-003-realtime-voice-build-vs-buy.md) and the `$/conv-min @ volume` + Pass columns in [RESULTS.md](./RESULTS.md).
- **Purpose:** give the Slice-0 run the two CFO-owned inputs it is blocked on — (1) the volume to project cost against, (2) the unit-economics ceiling that decides cost pass/fail — so the moment credentials land, the cost column is a pure plug-in, not another round-trip.

> These inputs require **no spend** to set. They were the CFO sub-blocker in SAU-179; that sub-blocker is now cleared. What remains in SAU-179 is the EA's credentials/board item — and see §3, which argues that item is far smaller than "board production spend."

---

## 1. Projected volume (use the **Base** row for the headline cost column)

Model cost at a **realistic 6-min conversation with accumulating context** — NOT active-audio-only. Every token-billed S2S vendor re-bills the growing context each turn, so active-audio-only understates true cost materially. The bench must report `$/conv-min` at the full 6-min session length and turn count, not per active-audio second.

| Scenario | Conversations / mo | Avg length | **Conv-min / mo** | Use for |
|---|---:|---:|---:|---|
| Bear (pilot / launch) | 2,000 | 6 min | 12,000 | downside burn, launch floor |
| **Base (Year-1 plan)** | **10,000** | **6 min** | **60,000** | **headline `$/conv-min @ vol` column** |
| Bull (scale) | 50,000 | 6 min | 300,000 | committed-use / volume-discount check |

- **Headline figure: 60,000 conv-min/mo** (ratifies the EA placeholder — it is the right Year-1 planning number).
- Also capture the **Bull** point for any vendor offering committed-use / tiered pricing: a vendor that loses at Base but wins at scale changes the recommendation horizon, and that belongs in the ADR.

## 2. Unit-economics envelope (the cost pass bar)

Expressed as **vendor `$/conv-min`** (what the bench measures directly). An **all-in** column adds a **+15% loading** for our own transport / WebRTC egress / observability / STT-fallback on top of vendor cost.

| Band | Vendor $/conv-min | All-in $/conv-min (+15%) | Meaning |
|---|---:|---:|---|
| 🟢 **Target** | **≤ $0.09** | ≤ $0.10 | passes cost gate cleanly |
| 🟡 **Watch** | $0.09 – $0.15 | $0.10 – $0.17 | passes **only** if it wins decisively on latency + privacy |
| 🔴 **Fail** | **> $0.15** | > $0.17 | **cost-gate fail regardless of weighted score** |

**Monthly cost this implies at Base (60,000 conv-min/mo):** Target ≤ **$5,400/mo** vendor; hard ceiling ≤ **$9,000/mo** vendor. (At Bull / 300k: Target ≤ $27k/mo.) These are the production burn numbers the board actually needs to approve — see §3.

### Margin basis (the assumption the ceiling rests on — CONFIRM with CEO/CRO)

The ceiling is derived from a **gross-margin floor of 70%** on the conversation product against an **assumed monetization of $0.60/conv-min** (≈ $3.60 of realizable revenue per 6-min session). At the hard all-in ceiling of $0.17/min that is a **72% GM**; at the target $0.10/min, **83% GM** — healthy for an AI-infra-heavy product (classic SaaS 75–80%; we accept a slightly lower floor given inference intensity, trending up as we optimize caching/cascade).

> **This $0.60/conv-min monetization is an assumption, not confirmed pricing.** It is the one input I cannot set alone. If confirmed price is `P` $/conv-min, recompute the bands by formula and the rest holds:
> - 🔴 hard all-in ceiling = `P × 0.30` (i.e. 70% GM floor) → vendor ceiling = `P × 0.30 / 1.15`
> - 🟢 target all-in ceiling = `P × 0.17` (≈ 83% GM) → vendor ceiling = `P × 0.17 / 1.15`
>
> Action: CEO/CRO confirm or replace `P`. Until then, the $0.60 anchor stands as the planning assumption and the bands above are live.

### Why this envelope is *discriminating* (a pass bar that can't separate candidates is useless)

Against the ADR-003 published-rate landscape: Gemini (~$0.02) clears Target with huge headroom; LiveKit/cascade blended (~$0.05–0.18) straddles Target/Watch depending on the STT/LLM/TTS mix; OpenAI Realtime uncached-typical ($0.18–0.46) **fails** unless prompt-caching / context management pulls it under $0.15. That is the correct behaviour — the envelope forces OpenAI to prove cost discipline, not assume it.

## 3. The spend blocker is smaller than it looks — decompose it

The SAU-179 blocker reads as "board spend approval." That conflates two very different commitments:

| | The **measurement spike** (SAU-176) | **Production commitment** (post-ADR) |
|---|---|---|
| What it buys | N≈50 turns × 3–4 vendors, metered, one-time | ongoing 60k+ conv-min/mo |
| Est. cost | **< $200 all-vendors, incl. re-runs** | $5k–27k/mo (per §2) |
| Approval needed | **CFO discretionary — no board cycle** | board, after measured ADR-003 |

The spike's worst case is ~40 min of audio/vendor × OpenAI's worst $0.46/min ≈ $18/vendor; ×4 vendors ×~2 re-runs, buffered, is **low tens of dollars** — categorically separate from the production commitment in §2. A board spike-spend approval is already in flight (approval `86482c32`, scoped to the three vendors, synthetic audio / no PII). **CFO endorses that approval at its requested bound (≤$100 is fine) — the spike cost is de-minimis and well within finance tolerance.** The board scrutiny that matters is the **production** commitment in §2, which should be decided *with the measured data in hand*, not before it.

> **Net effect:** from finance's side the spike spend is endorsed; the remaining gates on the SAU-176 live run are the **pending spend approval** (`86482c32`) and **credential provisioning** (EA) — both outside finance's lane.

## 4. What the bench must report back for the cost column

1. `$/conv-min` per vendor at **Base volume**, measured at full 6-min session length **with realistic context accumulation** (state turns/session and whether prompt-caching was on).
2. The same at **Bull volume** if the vendor publishes committed-use / tiered rates.
3. Band classification (🟢/🟡/🔴 per §2) → fills the **Pass?** cell for the cost dimension.
4. Note any caching / cascade configuration used to hit the number — the production number depends on it.

CFO will sign off the cost row of ADR-003 once these land.
