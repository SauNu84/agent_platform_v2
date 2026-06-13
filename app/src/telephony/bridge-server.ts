/**
 * Telephony media-stream bridge server (SAU-270, Phase 1 · WS1).
 *
 * A STANDALONE WebSocket server — deliberately NOT inside Next.js, which can't host
 * a long-lived raw WS upgrade cleanly under `next dev`. Twilio's `<Connect><Stream>`
 * (emitted by the inbound-call webhook) opens a socket here; for each call we:
 *   1. resolve the scenario from the `?slug=` query (the dialed number → agent),
 *   2. compile its prompt + clinic tools + fold in any Knowledge Base,
 *   3. open a server-side OpenAI Realtime session (platform key, μ-law both ways),
 *   4. hand both transports to the vendor-neutral `startCallBridge` orchestrator.
 *
 * Key-gated + fail-soft (AC #2): no `OPENAI_API_KEY` ⇒ we accept the socket and
 * close it cleanly with a log line instead of crashing. Run it with `npm run bridge`
 * and expose it over a tunnel (ngrok) so Twilio can reach `wss://…/telephony/bridge`.
 *
 * Synthetic callers / internal test numbers ONLY in this phase — no real patient
 * audio (HIPAA gate = SAU-268).
 */
import { WebSocketServer } from 'ws';
import { getStore } from '@/db';
import { getScenario } from '@/services/scenarios';
import { resolveKnowledgeContext } from '@/services/knowledge-base';
import { toCompiledScenario } from '@/domain/scenario';
import { resolveOpenAiVoice } from '@/lib/voices';
import { voiceKbCharBudget } from '@/voice/engine-router';
import { startCallBridge } from '@/services/telephony/bridge';
import { OpenAiRealtimeTransport } from '@/services/telephony/openai-realtime-transport';
import { TwilioMediaTransport } from '@/services/telephony/twilio-media-transport';
import { BRIDGE_WS_PATH, bridgeServerPort } from '@/services/telephony/twilio-config';

function log(event: string, meta?: Record<string, unknown>) {
  // One-line structured logs; stdout is the bridge's observability surface.
  console.log(JSON.stringify({ t: new Date().toISOString(), src: 'telephony-bridge', event, ...meta }));
}

function slugFromUrl(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? '', 'http://localhost');
    return u.searchParams.get('slug');
  } catch {
    return null;
  }
}

export function startBridgeServer(port = bridgeServerPort()): WebSocketServer {
  const wss = new WebSocketServer({ port, path: BRIDGE_WS_PATH });

  wss.on('connection', async (ws, req) => {
    const slug = slugFromUrl(req.url) ?? slugFromUrl(req.headers['sec-websocket-protocol'] as string);
    log('connection', { slug, remote: req.socket.remoteAddress });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      log('no_openai_key', { action: 'closing' });
      ws.close(1011, 'telephony bridge not configured (no OPENAI_API_KEY)');
      return;
    }
    if (!slug) {
      log('no_slug', { action: 'closing' });
      ws.close(1008, 'missing scenario slug');
      return;
    }

    try {
      const store = getStore();
      const scenario = await getScenario(store, slug);
      if (!scenario) {
        log('scenario_not_found', { slug });
        ws.close(1008, 'scenario not found');
        return;
      }

      const kb = await resolveKnowledgeContext(store, scenario.id, voiceKbCharBudget());
      const compiled = toCompiledScenario(scenario, { knowledgeBaseText: kb.text });
      const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
      const voice = resolveOpenAiVoice(scenario.voiceName, process.env.OPENAI_VOICE);

      const session = await store.createSession({ scenarioId: scenario.id, userId: null, vendor: 'openai' });

      const media = new TwilioMediaTransport(ws);
      const realtime = new OpenAiRealtimeTransport({
        apiKey,
        model,
        instructions: compiled.aiInstructions,
        voice,
        tools: compiled.tools,
      });

      await startCallBridge(media, realtime, {
        scenario,
        store,
        userId: null,
        sessionId: session.id,
        log,
      });
    } catch (e) {
      log('bridge_error', { message: (e as Error).message });
      try {
        ws.close(1011, 'bridge error');
      } catch {
        /* noop */
      }
    }
  });

  wss.on('listening', () => log('listening', { port, path: BRIDGE_WS_PATH }));
  return wss;
}

// Run directly: `npm run bridge` (tsx).
if (process.argv[1] && process.argv[1].endsWith('bridge-server.ts')) {
  startBridgeServer();
}
