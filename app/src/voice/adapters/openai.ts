/**
 * OpenAI Realtime adapter (LIVE) — one file = one vendor behind the interface.
 *
 * Transport: WebSocket to `gpt-realtime` (native S2S, async/non-blocking tools).
 * Auth: `OPENAI_API_KEY` (sourced from the SAU-176 project config `OpenAI_Key.value`).
 * Audio: PCM16 mono 24 kHz in/out (matches the fixture).
 *
 * Translates OpenAI server events → the vendor-neutral `SessionEvent` union so the
 * bench and platform never touch an OpenAI type.
 */
import WebSocket from 'ws';
import {
  RealtimeVoiceProvider, RealtimeSession, CompiledScenario, SessionOptions,
  SessionEvent, Transcript, ToolDefinition, ToolHandler, TurnUsage,
} from '../realtime-interface';
import { parseUsage, sumUsage } from '../openai-usage';

const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy'; // scenario voice 'Aoede' is a Gemini voice

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

export class OpenAIRealtimeProvider implements RealtimeVoiceProvider {
  readonly vendor = 'openai' as const;

  async startSession(scenario: CompiledScenario, opts?: SessionOptions): Promise<RealtimeSession> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY not set — live OpenAI Realtime run is BLOCKED on credential provisioning ' +
        '(SAU-181). Use `--vendor mock` to validate the harness offline.',
      );
    }

    // Tiered router (SAU-256): the platform passes the tier-resolved engine id;
    // fall back to the configured default for single-engine deployments.
    const model = opts?.model || DEFAULT_MODEL;
    const realtimeWs = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    const bridge = new Bridge();
    const handlers = new Map<string, ToolHandler>();
    const tTurns: Transcript['turns'] = [];
    const tCalls: Transcript['toolCalls'] = [];
    const perTurnUsage: TurnUsage[] = []; // one per response.done that carried usage
    let serverModel: string | undefined;  // server-reported model (rate attribution)
    const startedAt = Date.now();
    const sessionId = 'openai-' + scenario.id;

    // GA Realtime API (SAU-176): the beta protocol was sunset. No `OpenAI-Beta`
    // header; session config is restructured (audio nested under input/output,
    // PCM format is an object, `output_modalities` replaces `modalities`).
    const ws = new WebSocket(realtimeWs, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // Wait for the socket and configure the session before returning.
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model,
            output_modalities: ['audio'],
            // Cost lever #1 (SAU-256): prompt caching. OpenAI Realtime caches the
            // stable instruction/system prefix automatically and bills it at the
            // discounted cached rate (`response.done.usage.cached_tokens`, parsed
            // above). The lever we control is keeping that prefix stable + bounded
            // — which is why the KB block injected here is capped at the much
            // tighter VOICE_KB_CHAR_BUDGET (cost lever #2, resolved upstream)
            // rather than the 150K text budget. Realized cache hits are observable
            // per session in voice_usage.cached_*_tokens.
            instructions: scenario.aiInstructions,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: 'whisper-1' },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: opts?.vadSilenceMs ?? 500,
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: {
                format: { type: 'audio/pcm', rate: 24000 },
                voice: OPENAI_VOICE,
              },
            },
            tools: scenario.tools.map(toOpenAITool),
            tool_choice: 'auto',
          },
        }));
        resolve();
      });
      ws.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let ev: any;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      switch (ev.type) {
        case 'session.created':
        case 'session.updated':
          if (ev.session?.model) serverModel = ev.session.model;
          break;
        case 'input_audio_buffer.speech_started':
          bridge.emit({ type: 'user.speech.started', at: Date.now() });
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (ev.transcript) {
            bridge.emit({ type: 'user.transcript', text: ev.transcript, final: true, at: Date.now() });
            tTurns.push({ role: 'user', text: ev.transcript, at: Date.now() });
          }
          break;
        case 'response.output_audio.delta':
        case 'response.audio.delta': // legacy beta name, kept defensively
          if (ev.delta) bridge.emit({ type: 'audio.output', pcm: b64ToPcm(ev.delta), at: Date.now() }); // first ⇒ TTFA
          break;
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta': // legacy beta name
          if (ev.delta) bridge.emit({ type: 'agent.transcript', text: ev.delta, final: false, at: Date.now() });
          break;
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          if (ev.transcript) {
            bridge.emit({ type: 'agent.transcript', text: ev.transcript, final: true, at: Date.now() });
            tTurns.push({ role: 'agent', text: ev.transcript, at: Date.now() });
          }
          break;
        case 'response.function_call_arguments.done': {
          let args: unknown = {};
          try { args = JSON.parse(ev.arguments || '{}'); } catch { /* keep {} */ }
          bridge.emit({ type: 'tool.call', id: ev.call_id, name: ev.name, args, at: Date.now() });
          // gpt-realtime keeps generating audio while the tool runs (async/non-blocking).
          const run = handlers.get(ev.name)?.(args) ?? Promise.resolve({});
          Promise.resolve(run).then((result) => {
            bridge.emit({ type: 'tool.result', id: ev.call_id, result, at: Date.now() });
            tCalls.push({ name: ev.name, args, result, at: Date.now() });
            ws.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result) },
            }));
            ws.send(JSON.stringify({ type: 'response.create' }));
          });
          break;
        }
        case 'response.done': {
          if (ev.response?.status === 'cancelled') bridge.emit({ type: 'agent.interrupted', at: Date.now() });
          // Capture MEASURED token usage (SAU-197) — sum per-turn across the session.
          // Present on every terminal response (completed AND cancelled barge-ins).
          const usage = parseUsage(ev.response?.usage);
          if (usage) perTurnUsage.push(usage);
          break;
        }
        case 'error':
          bridge.emit({ type: 'error', message: ev.error?.message ?? JSON.stringify(ev.error), at: Date.now() });
          console.error('[openai] server error:', ev.error?.message ?? ev.error);
          break;
      }
    });
    ws.on('close', () => bridge.end());

    bridge.emit({ type: 'session.started', at: Date.now() });

    return {
      sessionId,
      events: bridge.iterable(),
      sendAudio(pcm: Int16Array) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcmToB64(pcm) }));
        }
      },
      registerTool(def: ToolDefinition, h: ToolHandler) { handlers.set(def.name, h); },
      interrupt() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response.cancel' }));
      },
      async stop(): Promise<Transcript> {
        bridge.emit({ type: 'session.ended', at: Date.now() });
        try { ws.close(); } catch { /* noop */ }
        bridge.end();
        return {
          sessionId, turns: tTurns, toolCalls: tCalls, startedAt, endedAt: Date.now(),
          usage: perTurnUsage.length ? sumUsage(perTurnUsage) : undefined,
          model: serverModel ?? model,
        };
      },
    };
  }
}

function toOpenAITool(t: ToolDefinition) {
  return { type: 'function', name: t.name, description: t.description, parameters: t.paramsSchema };
}
