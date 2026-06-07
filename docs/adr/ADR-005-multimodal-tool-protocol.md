# ADR-005 — Multimodal tool protocol (the stable internal event contract for agent tools)

- **Status:** Accepted — **CTO-ratified 2026-06-06** (vendor-neutral protocol; reinforces the ADR-003 swap-ability boundary)
- **Date:** 2026-06-06
- **Author:** Enterprise Architect
- **Deciders:** CTO (ratify), Engineering leads
- **Parent:** SAU-171 · **Issue:** SAU-175
- **Source design:** `docs/SAU-171-brandstorm-architecture.md` §2 (agentic, not chatbots), §5
- **Related:** [ADR-003](ADR-003-realtime-voice-build-vs-buy.md) (tool calls flow through the realtime adapter)

## Context

Agents are **agentic, not chatbots**: they invoke real tools — generate images, navigate **slides**, sketch **diagrams**, use a **whiteboard**, a **code editor**, and **cards** — *while the conversation continues* (mid-turn). Each tool both runs server-side logic and **renders something in the client UI** (the slide advances, the whiteboard draws). We need one stable contract for how a tool is declared, invoked by the model, executed, and reflected on the client — independent of which realtime vendor we pick ([ADR-003](ADR-003-realtime-voice-build-vs-buy.md)) and of which client surface (web, iframe embed) is attached.

The defer list (design §9) excludes meeting-bots/phone/white-label; this ADR covers the **core in-session tools** only.

## Decision

Define a **vendor-neutral tool protocol** layered on the realtime adapter's event stream. A tool is the unit; the model triggers it; the platform executes it; the client renders the resulting UI effect.

### 1. Tool declaration (content-as-code, [ADR-002](ADR-002-content-as-code.md))
A Scenario's `tools: [slides, whiteboard, code, diagram, image, cards]` lists enabled tools. Each tool has a **registered definition** (name, JSON-Schema args, description, side-effect class: `ui` | `server` | `both`). The adapter registers these with the vendor's function-calling mechanism at session start via `registerTool(def, handler)`.

### 2. Tool invocation flows over the session event stream (single contract)
Tool lifecycle is expressed as `SessionEvent`s on the same ordered stream as audio/transcript (see the realtime interface in [ADR-003](ADR-003-realtime-voice-build-vs-buy.md) and `docs/spikes/slice-0-realtime-voice/`):

```
tool.call    { id, name, args, at }      // model requests a tool, mid-turn
tool.result  { id, result, at }          // handler completed (server side)
ui.effect    { id, surface, op, payload, at }   // what the client must render
```

- **Mid-turn, non-blocking:** tool calls MUST NOT freeze speech. The handler runs async; the agent keeps talking ("let me pull that up…") and resumes/incorporates the result when ready. This is a **hard requirement on the realtime vendor** and a scored Slice-0 criterion ([ADR-003](ADR-003-realtime-voice-build-vs-buy.md) rubric, "mid-turn tool calling").
- **`ui.effect`** is the client-render contract: `surface` ∈ {`slides`,`whiteboard`,`code`,`diagram`,`image`,`cards`}; `op` is surface-specific (`slides.goto`, `whiteboard.draw`, `code.patch`, …); `payload` is JSON-Schema-validated. The **web app and the iframe embed consume the identical `ui.effect` events** — one renderer contract, two transports (the iframe receives them as postMessage events, mirroring the reference's iframe-events model).

### 3. Persistence
Every `tool.call` / `tool.result` / `ui.effect` is appended to `session_event` (see ERD) with its timestamp, so a Session can be replayed and the Analyst can score tool use against the rubric.

### 4. Failure semantics
- A tool handler error emits `tool.result { id, result: { error } }`; the agent is instructed to degrade gracefully in speech rather than stall.
- Unknown/disallowed tool name → rejected by the adapter (not forwarded to a handler), logged as a `tool.rejected` event.
- Per-tool timeout; on timeout the agent proceeds without the result and the UI shows a non-blocking failure state.

## Consequences

**Positive:** one contract spans every tool, every vendor, and every client surface — adding a tool is "register a definition + a handler + a renderer," with no change to the conversation engine or the vendor adapter. Tool events on the same stream make Sessions fully replayable and Analyst-scoreable. Iframe and web reuse one renderer contract.

**Negative / trade-offs:** mid-turn non-blocking tool calling is vendor-capability-dependent — if a candidate can't do it cleanly, that counts heavily against it in [ADR-003](ADR-003-realtime-voice-build-vs-buy.md). Each new UI surface (whiteboard, code editor) is still a real client build; this ADR standardizes the *protocol*, not the renderers. Tight `payload` schemas are required to keep the model from emitting unrenderable effects.

## Alternatives considered

1. **Vendor-native tool calling exposed directly to the app.** Rejected — couples the UI to a vendor's function-call format, breaking the [ADR-003](ADR-003-realtime-voice-build-vs-buy.md) swap-ability requirement.
2. **Separate side-channel (WebSocket) for UI effects, parallel to the voice stream.** Rejected for MVP — two ordering domains create audio/UI desync; one ordered event stream keeps "agent says X as the slide turns" coherent. Revisit only if a high-frequency UI surface needs its own transport.
