/**
 * LiveKit / cascade adapter (LIVE-pending-first-connect) — one file = one vendor
 * behind the `realtime-interface.ts` contract.
 *
 * ── What this measures ────────────────────────────────────────────────────────
 * The CTO named **the cascade** the priority measurement (SAU-176 ruling): regional
 * media + tunable endpointing is the most plausible way to beat the 800 ms TTFA bar
 * that OpenAI's hosted S2S missed (p95 1905 ms). This adapter implements the cascade
 * ARCHITECTURE directly:
 *
 *     mic PCM16 ──▶ Deepgram streaming STT ──▶ OpenAI chat LLM ──▶ Cartesia streaming TTS ──▶ audio.output
 *                  (endpointing/VAD)           (streamed tokens)    (sentence-streamed)        (first chunk ⇒ TTFA)
 *
 * This is "Option B" from the prior build plan: it gives the cascade's TTFA LOWER
 * BOUND with the fewest moving parts. If even this misses 800 ms, the heavier
 * **@livekit/agents** AgentSession wrapper ("Option A", which adds room/worker
 * orchestration overhead ON TOP of the same Deepgram+Cartesia plugins) cannot beat
 * it — so measuring the lower bound first is the decision-efficient order. Wrapping
 * this pipeline in @livekit/agents to quantify the framework's added overhead is a
 * documented follow-up the CTO can call once the lower bound is known (SAU-183).
 *
 * ── Built to the same standard as adapters/gemini.ts ──────────────────────────
 * Implemented to each vendor's DOCUMENTED protocol; typecheck-clean; fails clean
 * (never fakes a stream) when keys are absent. Unknown/unmodeled messages are logged
 * so the FIRST live run surfaces any protocol drift immediately — the explicit
 * lesson from OpenAI's Beta→GA migration. Models, voice, and endpointing are all
 * env-overridable so the first live run can be tuned without code edits.
 *
 * ── Keys required (live connect) ──────────────────────────────────────────────
 *   DEEPGRAM_API_KEY   — streaming STT.  ⚠️ NOT in SAU-182's original 5-key list;
 *                        the cascade cannot connect without it — flagged to EA.
 *   CARTESIA_API_KEY   — streaming TTS (SAU-182).
 *   OPENAI_API_KEY     — the LLM hop (already provisioned for the OpenAI run).
 *   CARTESIA_VOICE_ID  — a Cartesia voice UUID (defaulted + warned; confirm on first run).
 * LIVEKIT_URL/API_KEY/API_SECRET are NOT needed for this direct cascade (Option B);
 * they are only needed if/when we wrap it in @livekit/agents (Option A).
 */
import WebSocket from 'ws';
import {
  RealtimeVoiceProvider, RealtimeSession, CompiledScenario, SessionOptions,
  SessionEvent, Transcript, ToolDefinition, ToolHandler,
} from '../realtime-interface.ts';

const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-2';
const LLM_MODEL = process.env.LIVEKIT_CASCADE_LLM_MODEL || 'gpt-4o-mini';
const CARTESIA_MODEL = process.env.CARTESIA_MODEL || 'sonic-2';
const CARTESIA_VERSION = '2024-06-10';
// Cartesia requires a voice UUID (not a name like Gemini's "Aoede"). Env-overridable;
// the default is a documented Cartesia sample voice and is WARNED at startup so the
// first live run confirms it rather than silently using a stale id (Beta→GA discipline).
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091';
const AUDIO_RATE = 24000; // fixture is 24 kHz PCM16 mono; Deepgram + Cartesia both run at 24 kHz here (no resample)

// ── Event bridge: same shape as adapters/gemini.ts (push events, async-iterate) ─
class Bridge {
  private buf: SessionEvent[] = [];
  private waiters: Array<(r: IteratorResult<SessionEvent>) => void> = [];
  private done = false;
  emit(e: SessionEvent) { if (this.done) return; const w = this.waiters.shift(); if (w) w({ value: e, done: false }); else this.buf.push(e); }
  end() { this.done = true; let w; while ((w = this.waiters.shift())) w({ value: undefined as never, done: true }); }
  iterable(): AsyncIterable<SessionEvent> {
    const self = this;
    return { [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SessionEvent>>((res) => {
        const e = self.buf.shift();
        if (e) res({ value: e, done: false });
        else if (self.done) res({ value: undefined as never, done: true });
        else self.waiters.push(res);
      }),
    }) };
  }
}

const b64ToPcm = (b64: string): Int16Array => {
  const buf = Buffer.from(b64, 'base64');
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
};
const pcmToBytes = (pcm: Int16Array): Buffer =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/** Split streamed LLM text into speakable chunks so Cartesia can start early (low TTFA). */
function takeSpeakable(pending: string): { chunk: string; rest: string } {
  // flush on sentence-ending punctuation followed by a space, else hold
  const m = pending.match(/^[\s\S]*?[.!?,;:](\s|$)/);
  if (m) return { chunk: m[0], rest: pending.slice(m[0].length) };
  return { chunk: '', rest: pending };
}

export class LiveKitProvider implements RealtimeVoiceProvider {
  readonly vendor = 'livekit' as const;

  async startSession(scenario: CompiledScenario, opts?: SessionOptions): Promise<RealtimeSession> {
    const dgKey = process.env.DEEPGRAM_API_KEY;
    const ctKey = process.env.CARTESIA_API_KEY;
    const oaKey = process.env.OPENAI_API_KEY;
    const missing = [
      !dgKey && 'DEEPGRAM_API_KEY (STT)',
      !ctKey && 'CARTESIA_API_KEY (TTS)',
      !oaKey && 'OPENAI_API_KEY (LLM)',
    ].filter(Boolean) as string[];
    if (missing.length) {
      throw new Error(
        `LiveKit cascade BLOCKED on missing credential(s): ${missing.join(', ')} (SAU-182). ` +
        'NOTE: DEEPGRAM_API_KEY is required by the cascade STT hop but is NOT in SAU-182\'s ' +
        'original 5-key list — it must be provisioned too. Use `--vendor mock` to validate ' +
        'the harness offline. Fail-fast on purpose: refuses to emit an empty stream that ' +
        'would masquerade as a vendor result.',
      );
    }
    if (!process.env.CARTESIA_VOICE_ID) {
      console.warn(`[livekit] CARTESIA_VOICE_ID not set — using default sample voice ${CARTESIA_VOICE_ID}; ` +
        'confirm a real voice id on the first live run.');
    }
    // Surface the configured-vs-default endpointing so latency attribution is auditable.
    const endpointingMs = opts?.vadSilenceMs ?? 300; // cascade default; tune for the TTFA bound

    const bridge = new Bridge();
    const handlers = new Map<string, ToolHandler>();
    const tTurns: Transcript['turns'] = [];
    const tCalls: Transcript['toolCalls'] = [];
    const startedAt = Date.now();
    const sessionId = 'livekit-' + scenario.id;

    // ── Cartesia TTS: one WS for the whole session, one context_id per agent turn ─
    const ctParams = new URLSearchParams({ api_key: ctKey!, cartesia_version: CARTESIA_VERSION });
    const cartesia = new WebSocket(`wss://api.cartesia.ai/tts/websocket?${ctParams}`);
    let speaking = false;
    let turnGen = 0;        // bumped on barge-in to drop late audio from the cancelled turn
    let activeCtx = '';     // the context_id of the turn currently being spoken
    cartesia.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.context_id && msg.context_id !== activeCtx) return; // stale (barged) turn
      if (msg.type === 'chunk' && msg.data) {
        speaking = true;
        bridge.emit({ type: 'audio.output', pcm: b64ToPcm(msg.data), at: Date.now() }); // first ⇒ TTFA
        return;
      }
      if (msg.type === 'done' || msg.done) { speaking = false; return; }
      if (msg.type === 'error') {
        bridge.emit({ type: 'error', message: `cartesia: ${msg.error ?? JSON.stringify(msg)}`, at: Date.now() });
        console.error('[livekit] cartesia error:', msg.error ?? msg);
        return;
      }
      if (msg.type !== 'timestamps') console.error('[livekit] unhandled cartesia message:', Object.keys(msg));
    });
    cartesia.on('error', (e) => bridge.emit({ type: 'error', message: `cartesia ws: ${String(e)}`, at: Date.now() }));

    /** Speak one text fragment for the current turn (continue=true keeps the context open). */
    const speak = (text: string, ctx: string, last: boolean) => {
      if (cartesia.readyState !== WebSocket.OPEN || !text.trim()) {
        if (last && cartesia.readyState === WebSocket.OPEN) {
          cartesia.send(JSON.stringify({ context_id: ctx, model_id: CARTESIA_MODEL, transcript: '', continue: false,
            voice: { mode: 'id', id: CARTESIA_VOICE_ID }, output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: AUDIO_RATE }, language: 'en' }));
        }
        return;
      }
      cartesia.send(JSON.stringify({
        context_id: ctx, model_id: CARTESIA_MODEL, transcript: text, continue: !last,
        voice: { mode: 'id', id: CARTESIA_VOICE_ID },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: AUDIO_RATE }, language: 'en',
      }));
    };

    // ── LLM hop: stream OpenAI chat tokens → sentence-chunk into Cartesia ─────────
    const messages: Array<Record<string, unknown>> = [{ role: 'system', content: scenario.aiInstructions }];
    const tools = scenario.tools.map((t) => ({
      type: 'function', function: { name: t.name, description: t.description, parameters: t.paramsSchema },
    }));

    async function runLlmTurn(userText: string, ctx: string, gen: number): Promise<void> {
      messages.push({ role: 'user', content: userText });
      // tool loop: re-stream after a tool result until the model stops without a tool call
      for (let hop = 0; hop < 4; hop++) {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oaKey}` },
          body: JSON.stringify({ model: LLM_MODEL, messages, tools: tools.length ? tools : undefined, stream: true, temperature: 0.4 }),
        });
        if (!resp.ok || !resp.body) {
          bridge.emit({ type: 'error', message: `openai llm ${resp.status}: ${await resp.text().catch(() => '')}`, at: Date.now() });
          speak('', ctx, true);
          return;
        }
        let pending = '';        // text not yet flushed to TTS
        let fullText = '';       // full assistant text this hop
        const toolAcc = new Map<number, { id: string; name: string; args: string }>();
        let finish = '';
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let sse = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (gen !== turnGen) { try { await reader.cancel(); } catch { /* noop */ } return; } // barged
          sse += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = sse.indexOf('\n')) >= 0) {
            const line = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { finish = finish || 'stop'; continue; }
            let j: any; try { j = JSON.parse(data); } catch { continue; }
            const d = j.choices?.[0]?.delta; const fr = j.choices?.[0]?.finish_reason;
            if (fr) finish = fr;
            if (d?.content) {
              pending += d.content; fullText += d.content;
              if (!speaking) bridge.emit({ type: 'agent.speaking', at: Date.now() });
              let take; while ((take = takeSpeakable(pending)).chunk) { speak(take.chunk, ctx, false); pending = take.rest; }
            }
            for (const tc of d?.tool_calls ?? []) {
              const slot = toolAcc.get(tc.index) ?? { id: tc.id ?? '', name: '', args: '' };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (tc.function?.arguments) slot.args += tc.function.arguments;
              toolAcc.set(tc.index, slot);
            }
          }
        }
        if (gen !== turnGen) return;

        if (finish === 'tool_calls' && toolAcc.size) {
          if (pending.trim()) { speak(pending, ctx, false); pending = ''; }
          messages.push({ role: 'assistant', content: fullText || null,
            tool_calls: [...toolAcc.values()].map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })) });
          for (const t of toolAcc.values()) {
            let args: unknown = {}; try { args = JSON.parse(t.args || '{}'); } catch { /* keep {} */ }
            bridge.emit({ type: 'tool.call', id: t.id, name: t.name, args, at: Date.now() });
            const result = await (handlers.get(t.name)?.(args) ?? Promise.resolve({}));
            bridge.emit({ type: 'tool.result', id: t.id, result, at: Date.now() });
            tCalls.push({ name: t.name, args, result, at: Date.now() });
            messages.push({ role: 'tool', tool_call_id: t.id, content: JSON.stringify(result) });
          }
          continue; // re-stream with the tool result in context
        }

        // normal completion
        if (fullText) { messages.push({ role: 'assistant', content: fullText });
          tTurns.push({ role: 'agent', text: fullText, at: Date.now() });
          bridge.emit({ type: 'agent.transcript', text: fullText, final: true, at: Date.now() }); }
        speak(pending, ctx, true); // flush remainder + close the Cartesia context
        return;
      }
      speak('', ctx, true);
    }

    // ── Deepgram STT: one WS for the whole session; endpoints trigger LLM turns ────
    const dgParams = new URLSearchParams({
      encoding: 'linear16', sample_rate: String(AUDIO_RATE), channels: '1',
      model: DEEPGRAM_MODEL, interim_results: 'true', smart_format: 'true',
      vad_events: 'true', endpointing: String(endpointingMs),
    });
    const deepgram = new WebSocket(`wss://api.deepgram.com/v1/listen?${dgParams}`, {
      headers: { Authorization: `Token ${dgKey}` },
    });
    let utterance = '';
    deepgram.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'SpeechStarted') { bridge.emit({ type: 'user.speech.started', at: Date.now() }); return; }
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        const text = (alt?.transcript ?? '').trim();
        if (text) {
          bridge.emit({ type: 'user.transcript', text, final: !!msg.is_final, at: Date.now() });
          if (msg.is_final) utterance = (utterance ? utterance + ' ' : '') + text;
        }
        // speech_final = Deepgram's endpoint (end of user turn) → run the cascade
        if (msg.speech_final && utterance.trim()) {
          const userText = utterance.trim(); utterance = '';
          tTurns.push({ role: 'user', text: userText, at: Date.now() });
          const gen = turnGen; const ctx = `${sessionId}-${gen}-${Date.now()}`; activeCtx = ctx;
          void runLlmTurn(userText, ctx, gen).catch((e) =>
            bridge.emit({ type: 'error', message: `cascade turn: ${String(e)}`, at: Date.now() }));
        }
        return;
      }
      if (msg.type === 'UtteranceEnd') return; // covered by speech_final
      if (msg.type === 'Metadata') return;
      if (msg.type === 'Error' || msg.error) {
        bridge.emit({ type: 'error', message: `deepgram: ${msg.description ?? msg.error ?? JSON.stringify(msg)}`, at: Date.now() });
        console.error('[livekit] deepgram error:', msg);
        return;
      }
      console.error('[livekit] unhandled deepgram message:', msg.type ?? Object.keys(msg));
    });
    deepgram.on('error', (e) => bridge.emit({ type: 'error', message: `deepgram ws: ${String(e)}`, at: Date.now() }));

    // Open both sockets before returning so the first sendAudio isn't dropped.
    await Promise.all([
      new Promise<void>((res, rej) => { deepgram.once('open', () => res()); deepgram.once('error', rej); }),
      new Promise<void>((res, rej) => { cartesia.once('open', () => res()); cartesia.once('error', rej); }),
    ]);
    deepgram.on('close', () => bridge.end());

    bridge.emit({ type: 'session.started', at: Date.now() });

    return {
      sessionId,
      events: bridge.iterable(),
      sendAudio(pcm: Int16Array) {
        if (deepgram.readyState === WebSocket.OPEN) deepgram.send(pcmToBytes(pcm));
      },
      registerTool(def: ToolDefinition, h: ToolHandler) { handlers.set(def.name, h); },
      interrupt() {
        // Cascade barge-in: drop the in-flight turn (LLM read loop + late Cartesia audio
        // both gate on turnGen) and mark the agent interrupted.
        if (speaking) {
          turnGen++; activeCtx = ''; speaking = false;
          bridge.emit({ type: 'user.speech.started', at: Date.now() });
          bridge.emit({ type: 'agent.interrupted', at: Date.now() });
        }
      },
      async stop(): Promise<Transcript> {
        bridge.emit({ type: 'session.ended', at: Date.now() });
        try { if (deepgram.readyState === WebSocket.OPEN) deepgram.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* noop */ }
        try { deepgram.close(); } catch { /* noop */ }
        try { cartesia.close(); } catch { /* noop */ }
        bridge.end();
        return { sessionId, turns: tTurns, toolCalls: tCalls, startedAt, endedAt: Date.now() };
      },
    };
  }
}
