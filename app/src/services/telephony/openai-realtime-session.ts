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

/**
 * Headers for the server-side Realtime WebSocket (platform key — never the caller).
 * GA Realtime API (SAU-176/SAU-293): the beta protocol was sunset, so the
 * `OpenAI-Beta: realtime=v1` header is GONE — sending it now fails the connection
 * with `beta_api_shape_disabled`. Just the bearer key.
 */
export function openAiRealtimeHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
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
 * The `session.update` frame sent immediately after connect. GA Realtime API shape
 * (SAU-293): audio config is nested under `audio.input` / `audio.output`, the format
 * is an OBJECT (`{ type: 'audio/pcmu' }` = G.711 μ-law @ 8 kHz — Twilio's native
 * telephony codec, so we forward bytes with NO transcode), and `output_modalities`
 * replaces the old top-level `modalities`. Server VAD drives natural turn-taking +
 * barge-in; transcription on so we capture turns for the intake extractor.
 *
 * The old beta shape (`input_audio_format: 'g711_ulaw'`, etc.) was sunset and now
 * fails the whole session with `beta_api_shape_disabled` — which silently broke the
 * live telephony bridge until SAU-293 caught it with the synthetic-caller harness.
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
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          // `create_response` is what makes the agent actually REPLY when the caller
          // stops talking; without it the GA session just listens forever (a silent
          // agent on every live call). `interrupt_response` gives natural barge-in.
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
          transcription: { model: 'whisper-1' },
        },
        output: {
          format: { type: 'audio/pcmu' },
          voice: opts.voice,
        },
      },
      tools: opts.tools.map(toRealtimeTool),
      tool_choice: 'auto',
    },
  };
}
