/**
 * Browser Gemini Live transport (SAU-259, Phase 2.1).
 *
 * The OpenAI live path uses WebRTC (browser ↔ OpenAI). Gemini Live speaks a
 * different shape — a `BidiGenerateContent` **WebSocket** — so this is its
 * browser-side mirror of src/voice/adapters/gemini.ts (the server adapter): same
 * setup frame, same event names, same PCM rates, but using the Web Audio API
 * instead of Node `ws` + buffers.
 *
 * Auth: the browser NEVER sees GEMINI_API_KEY. The token route mints a short-lived
 * ephemeral auth token and hands us a ready `wsUrl` (with `?access_token=`). We
 * open the socket, send the server-built `setup` frame, stream mic audio up as
 * PCM16 @16 kHz, play the model's PCM16 @24 kHz downlink, and surface finalized
 * transcript turns so LiveDemo can render + persist them (same client-driven
 * persistence + metering path as the OpenAI live session).
 */

export interface GeminiTurn {
  role: 'user' | 'agent';
  text: string;
  at: number;
}

export interface GeminiLiveToken {
  wsUrl: string;
  setup: Record<string, unknown>;
  inputSampleRate?: number;
  outputSampleRate?: number;
}

export interface GeminiLiveHandlers {
  onUserTurn?: (turn: GeminiTurn) => void;
  onAgentTurn?: (turn: GeminiTurn) => void;
  onOpen?: () => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

const FRAME_SAMPLES = 2048; // ScriptProcessor block size (mic uplink granularity)

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Linear resample a mono Float32 buffer from one sample rate to another. */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (src - i0);
  }
  return out;
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Copy into an aligned buffer so the Int16 view is valid even on odd offsets.
  return new Int16Array(bytes.buffer);
}

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private captureCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private playCursor = 0; // next gapless playback start time (playbackCtx clock)
  private agentBuf = '';
  private readonly inRate: number;
  private readonly outRate: number;
  private closed = false;
  readonly turns: GeminiTurn[] = [];

  constructor(
    private readonly token: GeminiLiveToken,
    private readonly stream: MediaStream,
    private readonly handlers: GeminiLiveHandlers = {},
  ) {
    this.inRate = token.inputSampleRate ?? 16_000;
    this.outRate = token.outputSampleRate ?? 24_000;
  }

  start(): void {
    const ws = new WebSocket(this.token.wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify(this.token.setup)); // first frame = setup (server-built)
      this.startMicUplink();
      this.handlers.onOpen?.();
    };
    ws.onmessage = (e) => { void this.onMessage(e.data); };
    ws.onerror = () => this.handlers.onError?.('Gemini Live connection error');
    ws.onclose = () => { if (!this.closed) this.handlers.onClose?.(); };
  }

  // ── Mic uplink: capture → resample to 16 kHz → PCM16 → base64 → realtimeInput ──
  private startMicUplink(): void {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // Request the native input rate so we resample exactly once to 16 kHz.
    const ctx = new Ctx({ sampleRate: this.inRate });
    this.captureCtx = ctx;
    const source = ctx.createMediaStreamSource(this.stream);
    this.micSource = source;
    const processor = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (ev) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const resampled = resample(input, ctx.sampleRate, this.inRate);
      const pcm = floatToPcm16(resampled);
      this.ws.send(JSON.stringify({
        realtimeInput: { mediaChunks: [{ mimeType: `audio/pcm;rate=${this.inRate}`, data: pcm16ToBase64(pcm) }] },
      }));
    };
    source.connect(processor);
    // A muted gain sink keeps the processing graph pulling without echoing the mic.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(ctx.destination);
  }

  private ensurePlayback(): AudioContext {
    if (!this.playbackCtx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.playbackCtx = new Ctx();
      this.playCursor = this.playbackCtx.currentTime;
    }
    return this.playbackCtx;
  }

  // Schedule a PCM16 @outRate chunk back-to-back for gapless playback.
  private playPcm(pcm: Int16Array): void {
    const ctx = this.ensurePlayback();
    const buf = ctx.createBuffer(1, pcm.length, this.outRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.playCursor);
    src.start(startAt);
    this.playCursor = startAt + buf.duration;
  }

  private async toText(data: unknown): Promise<string> {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
    return '';
  }

  private async onMessage(data: unknown): Promise<void> {
    let ev: {
      setupComplete?: unknown;
      serverContent?: {
        interrupted?: boolean;
        inputTranscription?: { text?: string };
        outputTranscription?: { text?: string };
        modelTurn?: { parts?: Array<{ inlineData?: { data?: string }; inline_data?: { data?: string } }> };
        turnComplete?: boolean;
      };
      error?: { message?: string };
    };
    try { ev = JSON.parse(await this.toText(data)); } catch { return; }

    if (ev.setupComplete) return;
    if (ev.error) { this.handlers.onError?.(ev.error.message ?? 'Gemini Live error'); return; }

    const sc = ev.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      // Barge-in: drop any queued audio so the user isn't talked over.
      this.playCursor = this.playbackCtx?.currentTime ?? 0;
    }
    if (sc.inputTranscription?.text) {
      const turn: GeminiTurn = { role: 'user', text: sc.inputTranscription.text, at: Date.now() };
      this.turns.push(turn);
      this.handlers.onUserTurn?.(turn);
    }
    if (sc.outputTranscription?.text) this.agentBuf += sc.outputTranscription.text;
    for (const part of sc.modelTurn?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data) this.playPcm(base64ToPcm16(inline.data));
    }
    if (sc.turnComplete && this.agentBuf) {
      const turn: GeminiTurn = { role: 'agent', text: this.agentBuf, at: Date.now() };
      this.turns.push(turn);
      this.handlers.onAgentTurn?.(turn);
      this.agentBuf = '';
    }
  }

  /** Tear down the socket + audio graph; returns the captured transcript turns. */
  stop(): GeminiTurn[] {
    this.closed = true;
    try { this.processor?.disconnect(); } catch { /* noop */ }
    try { this.micSource?.disconnect(); } catch { /* noop */ }
    this.captureCtx?.close().catch(() => {});
    this.playbackCtx?.close().catch(() => {});
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
    this.processor = null;
    this.micSource = null;
    this.captureCtx = null;
    this.playbackCtx = null;
    return this.turns;
  }
}
