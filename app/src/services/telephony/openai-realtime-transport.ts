/**
 * OpenAI Realtime transport for the telephony bridge (SAU-270) — the concrete
 * `RealtimeTransport` over a server-side WebSocket. Thin glue around the protocol:
 * the bridge orchestrator (and its tests) only depend on the interface, so this
 * file is intentionally minimal and is exercised live, not in unit tests.
 *
 * Unlike the browser path (which uses an ephemeral client secret over WebRTC), the
 * server bridge connects with the PLATFORM key over WebSocket — the key never
 * leaves the server and the caller's audio never touches our client.
 */
import { WebSocket } from 'ws';
import type { ToolDefinition } from '@/voice/realtime-interface';
import type { RealtimeTransport } from './bridge';
import { openAiRealtimeWsUrl, openAiRealtimeHeaders, openAiSessionUpdate } from './openai-realtime-session';

export interface OpenAiRealtimeOptions {
  apiKey: string;
  model: string;
  instructions: string;
  voice: string;
  tools: ToolDefinition[];
}

export class OpenAiRealtimeTransport implements RealtimeTransport {
  readonly vendor = 'openai';
  private ws: WebSocket | null = null;
  private opts: OpenAiRealtimeOptions;
  private cbAudio: (b64: string) => void = () => {};
  private cbSpeech: () => void = () => {};
  private cbFn: (c: { callId: string; name: string; argsJson: string }) => void = () => {};
  private cbTranscript: (t: { role: 'user' | 'agent'; text: string }) => void = () => {};
  private cbError: (m: string) => void = () => {};
  private cbClose: () => void = () => {};

  constructor(opts: OpenAiRealtimeOptions) {
    this.opts = opts;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(openAiRealtimeWsUrl(this.opts.model), {
        headers: openAiRealtimeHeaders(this.opts.apiKey),
      });
      this.ws = ws;

      ws.on('open', () => {
        ws.send(
          JSON.stringify(
            openAiSessionUpdate({
              instructions: this.opts.instructions,
              voice: this.opts.voice,
              tools: this.opts.tools,
            }),
          ),
        );
        resolve();
      });
      ws.on('message', (data) => this.onMessage(data.toString('utf8')));
      ws.on('error', (err) => {
        this.cbError((err as Error).message);
        reject(err);
      });
      ws.on('close', () => this.cbClose());
    });
  }

  private onMessage(raw: string) {
    let evt: { type?: string; [k: string]: unknown };
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    switch (evt.type) {
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (typeof evt.delta === 'string') this.cbAudio(evt.delta);
        break;
      case 'input_audio_buffer.speech_started':
        this.cbSpeech();
        break;
      case 'response.function_call_arguments.done':
        this.cbFn({
          callId: String(evt.call_id ?? ''),
          name: String(evt.name ?? ''),
          argsJson: String(evt.arguments ?? '{}'),
        });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof evt.transcript === 'string') this.cbTranscript({ role: 'user', text: evt.transcript });
        break;
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (typeof evt.transcript === 'string') this.cbTranscript({ role: 'agent', text: evt.transcript });
        break;
      case 'error':
        this.cbError(JSON.stringify(evt.error ?? evt));
        break;
      default:
        break;
    }
  }

  appendAudio(muLawBase64: string): void {
    this.ws?.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: muLawBase64 }));
  }

  sendToolResult(callId: string, output: unknown): void {
    this.ws?.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
      }),
    );
    this.ws?.send(JSON.stringify({ type: 'response.create' }));
  }

  onAudioDelta(cb: (b64: string) => void) { this.cbAudio = cb; }
  onSpeechStarted(cb: () => void) { this.cbSpeech = cb; }
  onFunctionCall(cb: (c: { callId: string; name: string; argsJson: string }) => void) { this.cbFn = cb; }
  onTranscript(cb: (t: { role: 'user' | 'agent'; text: string }) => void) { this.cbTranscript = cb; }
  onError(cb: (m: string) => void) { this.cbError = cb; }
  onClose(cb: () => void) { this.cbClose = cb; }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}
