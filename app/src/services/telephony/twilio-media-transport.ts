/**
 * Twilio Media Streams transport for the telephony bridge (SAU-270) — the concrete
 * `MediaTransport` wrapping the WebSocket Twilio opens to our bridge server. Thin
 * protocol glue (parse inbound start/media/stop, emit outbound media/clear); the
 * orchestration + tests live against the interface in `bridge.ts`.
 *
 * The `streamSid` arrives on the `start` frame and must be echoed on every outbound
 * frame, so we buffer outbound audio until it's known.
 */
import type { WebSocket } from 'ws';
import type { MediaTransport } from './bridge';
import { parseTwilioFrame, outboundMediaFrame, clearFrame } from './twilio-protocol';

export class TwilioMediaTransport implements MediaTransport {
  readonly label = 'Twilio Media Streams';
  private ws: WebSocket;
  private streamSid: string | null = null;
  private pending: string[] = [];
  private cbAudio: (b64: string) => void = () => {};
  private cbClose: () => void = () => {};
  /** Surfaced so the bridge server can resolve the scenario from custom params. */
  callSid: string | null = null;
  customParameters: Record<string, string> = {};
  /**
   * Resolves with the `start` frame's custom parameters — where Twilio delivers the
   * signed stream values (SAU-541). The bridge must not admit a call before this.
   */
  readonly started: Promise<Record<string, string>>;
  private resolveStarted: (p: Record<string, string>) => void = () => {};

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.started = new Promise((resolve) => { this.resolveStarted = resolve; });
    ws.on('message', (data) => this.onFrame(data));
    ws.on('close', () => this.cbClose());
    ws.on('error', () => this.cbClose());
  }

  private onFrame(data: unknown) {
    const frame = parseTwilioFrame(data as Buffer);
    if (!frame) return;
    if (frame.event === 'start') {
      this.streamSid = frame.streamSid ?? frame.start?.streamSid ?? null;
      this.callSid = frame.start?.callSid ?? null;
      this.customParameters = frame.start?.customParameters ?? {};
      // Flush anything queued before we learned the streamSid.
      if (this.streamSid) {
        for (const payload of this.pending) this.ws.send(outboundMediaFrame(this.streamSid, payload));
        this.pending = [];
      }
      this.resolveStarted(this.customParameters);
    } else if (frame.event === 'media') {
      if (frame.media?.payload) this.cbAudio(frame.media.payload);
    } else if (frame.event === 'stop') {
      this.cbClose();
    }
  }

  onAudio(cb: (b64: string) => void) { this.cbAudio = cb; }
  onClose(cb: () => void) { this.cbClose = cb; }

  sendAudio(muLawBase64: string): void {
    if (!this.streamSid) {
      this.pending.push(muLawBase64);
      return;
    }
    this.ws.send(outboundMediaFrame(this.streamSid, muLawBase64));
  }

  clear(): void {
    if (this.streamSid) this.ws.send(clearFrame(this.streamSid));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}
