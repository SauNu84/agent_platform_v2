/**
 * Google Gemini Live adapter (LIVE) — one file = one vendor behind the interface
 * (ADR-003). SAU-258, Phase 2 of the multi-model voice plan (SAU-254): a second,
 * user-selectable native speech-to-speech engine at ~⅓ the cost of gpt-realtime.
 *
 * Transport: WebSocket to the Gemini Live `BidiGenerateContent` endpoint (native
 * audio dialog). Auth: `GEMINI_API_KEY` (key-gated; the session-service falls back
 * to the mock adapter when the key is absent, so a key-less deploy never crashes).
 * Audio: PCM16 mono — 16 kHz in, 24 kHz out (Gemini Live's native rates).
 *
 * Translates Gemini server events → the vendor-neutral `SessionEvent` union so the
 * platform and the cost benchmark never touch a Gemini SDK type — identical seam
 * shape to the OpenAI Realtime adapter.
 */
import WebSocket from 'ws';
import {
  RealtimeVoiceProvider, RealtimeSession, CompiledScenario, SessionOptions,
  SessionEvent, Transcript, ToolDefinition, ToolHandler, TurnUsage, SessionUsage,
} from '../realtime-interface';

const DEFAULT_MODEL = process.env.VOICE_ENGINE_GEMINI || 'gemini-2.5-flash-preview-native-audio-dialog';
// Gemini's prebuilt voices differ from OpenAI's (e.g. 'Aoede', 'Puck', 'Charon').
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Aoede';
const LIVE_HOST = 'wss://generativelanguage.googleapis.com';
const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

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
const pcmToB64 = (pcm: Int16Array): string =>
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/**
 * Parse one `usageMetadata` object → vendor-neutral TurnUsage.
 *
 * Gemini reports modality-split token counts:
 *   usageMetadata.promptTokensDetails[]   = [{ modality: 'AUDIO'|'TEXT', tokenCount }]
 *   usageMetadata.responseTokensDetails[] = [{ modality: 'AUDIO'|'TEXT', tokenCount }]
 *   usageMetadata.cachedContentTokenCount = portion of the prompt served from cache
 *   usageMetadata.totalTokenCount
 * When the modality split is absent we attribute prompt/response tokens to audio
 * (a native S2S turn is ~entirely audio) — the conservative cost assumption.
 */
function parseUsage(u: any): TurnUsage | null {
  if (!u) return null;
  const byModality = (arr: any): { text: number; audio: number } => {
    const out = { text: 0, audio: 0 };
    if (Array.isArray(arr)) {
      for (const d of arr) {
        const c = n(d?.tokenCount);
        if (d?.modality === 'TEXT') out.text += c;
        else out.audio += c; // AUDIO or unspecified
      }
    }
    return out;
  };
  const prompt = byModality(u.promptTokensDetails);
  const response = byModality(u.responseTokensDetails);
  let inputText = prompt.text;
  let inputAudio = prompt.audio;
  if (!inputText && !inputAudio) inputAudio = n(u.promptTokenCount);
  let outputText = response.text;
  let outputAudio = response.audio;
  if (!outputText && !outputAudio) outputAudio = n(u.responseTokenCount ?? u.candidatesTokenCount);
  // Gemini reports cached tokens as a single count; attribute to audio first.
  const cachedTotal = n(u.cachedContentTokenCount);
  const cachedAudio = Math.min(cachedTotal, inputAudio);
  const cachedText = Math.min(cachedTotal - cachedAudio, inputText);
  return {
    inputTextTokens: inputText,
    inputAudioTokens: inputAudio,
    cachedTextTokens: cachedText,
    cachedAudioTokens: cachedAudio,
    outputTextTokens: outputText,
    outputAudioTokens: outputAudio,
    totalTokens: n(u.totalTokenCount) || inputText + inputAudio + outputText + outputAudio,
  };
}

function sumUsage(perTurn: TurnUsage[]): SessionUsage {
  const totals: TurnUsage = {
    inputTextTokens: 0, inputAudioTokens: 0, cachedTextTokens: 0,
    cachedAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0, totalTokens: 0,
  };
  for (const t of perTurn) {
    totals.inputTextTokens += t.inputTextTokens;
    totals.inputAudioTokens += t.inputAudioTokens;
    totals.cachedTextTokens += t.cachedTextTokens;
    totals.cachedAudioTokens += t.cachedAudioTokens;
    totals.outputTextTokens += t.outputTextTokens;
    totals.outputAudioTokens += t.outputAudioTokens;
    totals.totalTokens += t.totalTokens;
  }
  return { perTurn, totals };
}

export class GeminiRealtimeProvider implements RealtimeVoiceProvider {
  readonly vendor = 'gemini' as const;

  async startSession(scenario: CompiledScenario, opts?: SessionOptions): Promise<RealtimeSession> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY not set — live Gemini Live run is BLOCKED on credential provisioning. ' +
        'The platform falls back to the mock adapter when the key is absent (no crash).',
      );
    }

    // SAU-258: the platform passes the engine id the router resolved; fall back to
    // the configured default for single-engine deployments.
    const model = opts?.model || DEFAULT_MODEL;
    const url = `${LIVE_HOST}${LIVE_PATH}?key=${encodeURIComponent(apiKey)}`;

    const bridge = new Bridge();
    const handlers = new Map<string, ToolHandler>();
    const tTurns: Transcript['turns'] = [];
    const tCalls: Transcript['toolCalls'] = [];
    const perTurnUsage: TurnUsage[] = [];
    let agentBuf = '';        // accumulate streamed agent transcript until turnComplete
    const startedAt = Date.now();
    const sessionId = 'gemini-' + scenario.id;

    const ws = new WebSocket(url);

    // Wait for the socket, send the setup frame, then await setupComplete.
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({
          setup: {
            model: model.startsWith('models/') ? model : `models/${model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } } },
            },
            // Cost lever (SAU-256/258): a small, STABLE system instruction prefix is
            // what lets Gemini's context cache serve it cheaply turn-over-turn. The
            // injected KB block is already bounded to VOICE_KB_CHAR_BUDGET upstream.
            systemInstruction: { parts: [{ text: scenario.aiInstructions }] },
            // Native input/output transcription so we capture both sides of the call.
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: scenario.tools.length ? [{ functionDeclarations: scenario.tools.map(toGeminiTool) }] : undefined,
          },
        }));
        resolve();
      });
      ws.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let ev: any;
      try { ev = JSON.parse(raw.toString()); } catch { return; }

      if (ev.setupComplete) return;

      if (ev.serverContent) {
        const sc = ev.serverContent;
        if (sc.interrupted) bridge.emit({ type: 'agent.interrupted', at: Date.now() });
        if (sc.inputTranscription?.text) {
          bridge.emit({ type: 'user.transcript', text: sc.inputTranscription.text, final: true, at: Date.now() });
          tTurns.push({ role: 'user', text: sc.inputTranscription.text, at: Date.now() });
        }
        if (sc.outputTranscription?.text) {
          agentBuf += sc.outputTranscription.text;
          bridge.emit({ type: 'agent.transcript', text: sc.outputTranscription.text, final: false, at: Date.now() });
        }
        for (const part of sc.modelTurn?.parts ?? []) {
          const inline = part.inlineData ?? part.inline_data;
          if (inline?.data) bridge.emit({ type: 'audio.output', pcm: b64ToPcm(inline.data), at: Date.now() }); // first ⇒ TTFA
        }
        if (sc.turnComplete && agentBuf) {
          bridge.emit({ type: 'agent.transcript', text: agentBuf, final: true, at: Date.now() });
          tTurns.push({ role: 'agent', text: agentBuf, at: Date.now() });
          agentBuf = '';
        }
      }

      if (ev.toolCall?.functionCalls) {
        for (const fc of ev.toolCall.functionCalls) {
          const args = fc.args ?? {};
          bridge.emit({ type: 'tool.call', id: fc.id ?? fc.name, name: fc.name, args, at: Date.now() });
          const run = handlers.get(fc.name)?.(args) ?? Promise.resolve({});
          Promise.resolve(run).then((result) => {
            bridge.emit({ type: 'tool.result', id: fc.id ?? fc.name, result, at: Date.now() });
            tCalls.push({ name: fc.name, args, result, at: Date.now() });
            ws.send(JSON.stringify({
              toolResponse: { functionResponses: [{ id: fc.id ?? fc.name, name: fc.name, response: { result } }] },
            }));
          });
        }
      }

      if (ev.usageMetadata) {
        const usage = parseUsage(ev.usageMetadata);
        if (usage) perTurnUsage.push(usage);
      }
    });
    ws.on('close', () => bridge.end());
    ws.on('error', (e) => bridge.emit({ type: 'error', message: e instanceof Error ? e.message : String(e), at: Date.now() }));

    bridge.emit({ type: 'session.started', at: Date.now() });

    return {
      sessionId,
      events: bridge.iterable(),
      sendAudio(pcm: Int16Array) {
        if (ws.readyState === WebSocket.OPEN) {
          // Gemini Live native input is PCM16 mono @ 16 kHz.
          ws.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: pcmToB64(pcm) }] } }));
        }
      },
      registerTool(def: ToolDefinition, h: ToolHandler) { handlers.set(def.name, h); },
      interrupt() {
        // A fresh activityStart signals barge-in; Gemini also auto-detects via VAD.
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      },
      async stop(): Promise<Transcript> {
        bridge.emit({ type: 'session.ended', at: Date.now() });
        try { ws.close(); } catch { /* noop */ }
        bridge.end();
        return {
          sessionId, turns: tTurns, toolCalls: tCalls, startedAt, endedAt: Date.now(),
          usage: perTurnUsage.length ? sumUsage(perTurnUsage) : undefined,
          model,
        };
      },
    };
  }
}

function toGeminiTool(t: ToolDefinition) {
  return { name: t.name, description: t.description, parameters: t.paramsSchema };
}
