/**
 * OpenAI Realtime session config for the TELEPHONY bridge (SAU-270) — pure builders
 * kept separate from the `ws` transport so they unit-test without a socket.
 *
 * The key fact that makes the bridge cheap: Twilio Media Streams carry G.711 μ-law
 * @ 8 kHz, and OpenAI Realtime accepts/emits `g711_ulaw` natively — so we set both
 * input and output formats to μ-law and forward bytes with NO resampling/transcode.
 *
 * Tools come straight from the compiled scenario (SAU-267 clinic tools), translated
 * into the Realtime `function` tool shape. Server VAD drives turn-taking + barge-in.
 */
import type { ToolDefinition } from '@/voice/realtime-interface';

/** WebSocket URL for the OpenAI Realtime API for a given model. */
export function openAiRealtimeWsUrl(model: string): string {
  const base = process.env.OPENAI_REALTIME_WS_URL || 'wss://api.openai.com/v1/realtime';
  return `${base}?model=${encodeURIComponent(model)}`;
}

/** Headers for the server-side Realtime WebSocket (platform key — never the caller). */
export function openAiRealtimeHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' };
}

/** Map a compiled-scenario tool to the OpenAI Realtime `function` tool shape. */
export function toRealtimeTool(t: ToolDefinition): {
  type: 'function';
  name: string;
  description: string;
  parameters: object;
} {
  return { type: 'function', name: t.name, description: t.description, parameters: t.paramsSchema };
}

/**
 * The `session.update` frame sent immediately after connect. μ-law both ways for a
 * transcode-free phone bridge; server VAD for natural turn-taking + barge-in;
 * transcription on so we capture turns for the intake extractor.
 */
export function openAiSessionUpdate(opts: {
  instructions: string;
  voice: string;
  tools: ToolDefinition[];
}): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: opts.instructions,
      voice: opts.voice,
      input_audio_format: 'g711_ulaw',
      output_audio_format: 'g711_ulaw',
      turn_detection: { type: 'server_vad' },
      input_audio_transcription: { model: 'whisper-1' },
      tools: opts.tools.map(toRealtimeTool),
      tool_choice: 'auto',
    },
  };
}
