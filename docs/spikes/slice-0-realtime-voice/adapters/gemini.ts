/**
 * Google Gemini Live adapter (LIVE) — one file = one vendor behind the interface.
 *
 * Transport: WebSocket BidiGenerateContent (native-audio Live API).
 * Auth: `GEMINI_API_KEY` (load-env.ts aliases Gemini_Key/GOOGLE_API_KEY → this).
 * Audio: Gemini Live takes PCM16 mono **16 kHz** input, emits 24 kHz output. The
 *   fixture is 24 kHz, so sendAudio resamples 24k→16k (linear) before sending.
 *
 * Implemented to the documented v1beta Live protocol; typecheck-clean. The FIRST
 * live run (when SAU-182 provisions the key) will confirm model id + field names —
 * unknown message types are logged so any protocol drift surfaces immediately
 * (lesson from OpenAI's Beta→GA migration). Model + voice are env-overridable.
 */
import WebSocket from 'ws';
import {
  RealtimeVoiceProvider, RealtimeSession, CompiledScenario, SessionOptions,
  SessionEvent, Transcript, ToolDefinition, ToolHandler,
} from '../realtime-interface.ts';

// Live (bidiGenerateContent) model. The original `gemini-2.0-flash-live-001` is NOT
// served on v1beta for this key (verified 2026-06-07: WS close 1008 "not found ...
// not supported for bidiGenerateContent"). ListModels → the live-capable set is the
// 2.5 native-audio family + gemini-3.1-flash-live-preview. Native-audio is the true
// s2s equivalent of OpenAI Realtime (the comparison intent). Pinned-dated for repro;
// env-overridable so the operator/CTO can swap (e.g. to 3.1) without a code change.
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const LIVE_WS =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const INPUT_RATE = 16000; // Gemini Live input requirement

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

/** Linear resample PCM16 from `from` Hz to `to` Hz (good enough for a bench). */
function resamplePcm(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const ratio = to / from;
  const outLen = Math.max(1, Math.floor(pcm.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = (pcm[i0] * (1 - frac) + pcm[i1] * frac) | 0;
  }
  return out;
}
const pcmToB64 = (pcm: Int16Array): string =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');

export class GeminiLiveProvider implements RealtimeVoiceProvider {
  readonly vendor = 'gemini' as const;

  async startSession(scenario: CompiledScenario, opts?: SessionOptions): Promise<RealtimeSession> {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY not set — live Gemini Live run is BLOCKED on credential provisioning ' +
        '(SAU-182). Use `--vendor mock` to validate the harness offline.',
      );
    }

    const bridge = new Bridge();
    const handlers = new Map<string, ToolHandler>();
    const tTurns: Transcript['turns'] = [];
    const tCalls: Transcript['toolCalls'] = [];
    const startedAt = Date.now();
    const sessionId = 'gemini-' + scenario.id;
    let speaking = false;

    const ws = new WebSocket(`${LIVE_WS}?key=${apiKey}`);

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: scenario.voice.name || 'Aoede' } } },
            },
            systemInstruction: { parts: [{ text: scenario.aiInstructions }] },
            tools: [{ functionDeclarations: scenario.tools.map(toGeminiDecl) }],
            // Pin the endpoint window so bench net-of-VAD TTFA (gross − this) is well-defined
            // and comparable to OpenAI's 500 ms (CTO ask, SAU-176).
            realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: opts?.vadSilenceMs ?? 500 } },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        }));
        resolve();
      });
      ws.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.setupComplete) return;

      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) { speaking = false; bridge.emit({ type: 'agent.interrupted', at: Date.now() }); }
        for (const part of sc.modelTurn?.parts ?? []) {
          if (part.inlineData?.data && (part.inlineData.mimeType || '').startsWith('audio/')) {
            speaking = true;
            bridge.emit({ type: 'audio.output', pcm: b64ToPcm(part.inlineData.data), at: Date.now() }); // first ⇒ TTFA
          }
          if (part.text) bridge.emit({ type: 'agent.transcript', text: part.text, final: false, at: Date.now() });
        }
        if (sc.outputTranscription?.text) {
          bridge.emit({ type: 'agent.transcript', text: sc.outputTranscription.text, final: true, at: Date.now() });
          tTurns.push({ role: 'agent', text: sc.outputTranscription.text, at: Date.now() });
        }
        if (sc.inputTranscription?.text) {
          bridge.emit({ type: 'user.transcript', text: sc.inputTranscription.text, final: true, at: Date.now() });
          tTurns.push({ role: 'user', text: sc.inputTranscription.text, at: Date.now() });
        }
        if (sc.turnComplete) speaking = false;
        return;
      }

      if (msg.toolCall) {
        for (const fc of msg.toolCall.functionCalls ?? []) {
          const args = fc.args ?? {};
          bridge.emit({ type: 'tool.call', id: fc.id ?? fc.name, name: fc.name, args, at: Date.now() });
          const run = handlers.get(fc.name)?.(args) ?? Promise.resolve({});
          Promise.resolve(run).then((result) => {
            bridge.emit({ type: 'tool.result', id: fc.id ?? fc.name, result, at: Date.now() });
            tCalls.push({ name: fc.name, args, result, at: Date.now() });
            // NON_BLOCKING tool → model keeps talking; just return the response.
            ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result } }] } }));
          });
        }
        return;
      }

      if (msg.error || msg.goAway) {
        const m = msg.error?.message ?? JSON.stringify(msg.error ?? msg.goAway);
        bridge.emit({ type: 'error', message: m, at: Date.now() });
        console.error('[gemini] server error:', m);
        return;
      }
      // Surface anything unmodeled so first-live-run protocol drift is obvious.
      console.error('[gemini] unhandled message keys:', Object.keys(msg));
    });
    // Abnormal closes (bad model id 1008, billing 1011, auth) arrive as a close FRAME,
    // never as a `message` — the original adapter only logged via `message`, so these
    // failed silently as a 0-event hang. Surface the close reason as an `error` event so
    // protocol drift / billing blockers are immediately visible (the lesson the file
    // comment promised but didn't deliver). 1000 = normal stop() teardown.
    ws.on('close', (code: number, reason: Buffer) => {
      if (code !== 1000) {
        const m = `Gemini Live WS closed abnormally: code=${code} reason=${reason?.toString() || '(none)'}`;
        bridge.emit({ type: 'error', message: m, at: Date.now() });
        console.error('[gemini]', m);
      }
      bridge.end();
    });

    bridge.emit({ type: 'session.started', at: Date.now() });

    return {
      sessionId,
      events: bridge.iterable(),
      sendAudio(pcm: Int16Array) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const down = resamplePcm(pcm, 24000, INPUT_RATE);
        ws.send(JSON.stringify({
          realtimeInput: { mediaChunks: [{ mimeType: `audio/pcm;rate=${INPUT_RATE}`, data: pcmToB64(down) }] },
        }));
      },
      registerTool(def: ToolDefinition, h: ToolHandler) { handlers.set(def.name, h); },
      interrupt() {
        // Bench-forced barge-in anchor; Gemini also auto-interrupts on detected speech.
        if (speaking) bridge.emit({ type: 'user.speech.started', at: Date.now() });
      },
      async stop(): Promise<Transcript> {
        bridge.emit({ type: 'session.ended', at: Date.now() });
        try { ws.close(); } catch { /* noop */ }
        bridge.end();
        return { sessionId, turns: tTurns, toolCalls: tCalls, startedAt, endedAt: Date.now() };
      },
    };
  }
}

function toGeminiDecl(t: ToolDefinition) {
  return { name: t.name, description: t.description, parameters: t.paramsSchema, behavior: 'NON_BLOCKING' };
}
