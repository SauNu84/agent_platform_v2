/**
 * Telephony media-stream bridge server (SAU-270, Phase 1 · WS1).
 *
 * A STANDALONE WebSocket server — deliberately NOT inside Next.js, which can't host
 * a long-lived raw WS upgrade cleanly under `next dev`. Twilio's `<Connect><Stream>`
 * (emitted by the inbound-call webhook) opens a socket here; for each call we:
 *   0. AUTHENTICATE the stream (SAU-541): wait for Twilio's `start` frame and verify
 *      the `slug|to|exp` HMAC the webhook signed into `<Parameter>`s. Unsigned,
 *      tampered or expired ⇒ `1008` before any tenant lookup or OpenAI session.
 *   1. resolve the scenario from the signed `slug`,
 *   2. ADMIT the call (SAU-525): the signed dialed `to` number → clinic tenant → owner
 *      (the billing principal), pre-flight cap check, per-tenant engine — or
 *      refuse it with a typed reason. No tenant ⇒ no call. Never an unmetered call.
 *   3. compile its prompt + the TENANT's clinic rules + fold in any Knowledge Base,
 *   4. open a server-side OpenAI Realtime session on the tenant's engine,
 *   5. hand both transports to the vendor-neutral `startCallBridge` orchestrator,
 *      bound to the owner's RLS context, and meter the call into `voice_usage`
 *      on finalize exactly like a web session.
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
import { runWithActor } from '@/auth/actor';
import { getScenario } from '@/services/scenarios';
import { resolveKnowledgeContext } from '@/services/knowledge-base';
import { toCompiledScenario } from '@/domain/scenario';
import { resolveOpenAiVoice } from '@/lib/voices';
import { voiceKbCharBudget } from '@/voice/engine-router';
import { getClinicConfig } from '@/services/clinic-config';
import { runClinicTool } from '@/services/clinic-booking';
import { admitInboundCall, CallAdmissionError } from '@/services/telephony/call-admission';
import { startCallBridge } from '@/services/telephony/bridge';
import { OpenAiRealtimeTransport } from '@/services/telephony/openai-realtime-transport';
import { TwilioMediaTransport } from '@/services/telephony/twilio-media-transport';
import { BRIDGE_WS_PATH, bridgeServerPort, bridgeAuthRequired, resolveTwilioConfig } from '@/services/telephony/twilio-config';
import { authorizeBridgeStream, SeenStreamSignatures } from '@/services/telephony/bridge-auth';

/** Twilio sends `start` right after connecting; a socket that stays silent is not Twilio. */
const START_FRAME_TIMEOUT_MS = 10_000;

function log(event: string, meta?: Record<string, unknown>) {
  // One-line structured logs; stdout is the bridge's observability surface.
  console.log(JSON.stringify({ t: new Date().toISOString(), src: 'telephony-bridge', event, ...meta }));
}

/** The `start` frame's custom parameters, or null on timeout / early hang-up. */
function awaitStart(media: TwilioMediaTransport, ws: import('ws').WebSocket): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), START_FRAME_TIMEOUT_MS);
    const done = (v: Record<string, string> | null) => { clearTimeout(timer); resolve(v); };
    ws.once('close', () => done(null));
    media.started.then(done);
  });
}

function safeParse(json: string): unknown {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

export function startBridgeServer(port = bridgeServerPort()): WebSocketServer {
  const wss = new WebSocketServer({ port, path: BRIDGE_WS_PATH });
  // Each signed stream opens at most one call (CISO N1).
  const seen = new SeenStreamSignatures();

  wss.on('connection', async (ws, req) => {
    log('connection', { remote: req.socket.remoteAddress });
    // Attach the transport FIRST so the `start` frame (streamSid + params) isn't lost.
    const media = new TwilioMediaTransport(ws);

    // ── Stream auth (SAU-541): nothing below runs for a socket the webhook didn't sign.
    const customParameters = await awaitStart(media, ws);
    if (!customParameters) {
      log('no_start_frame', { action: 'closing' });
      ws.close(1008, 'no start frame');
      return;
    }
    const auth = authorizeBridgeStream({
      customParameters,
      requestUrl: req.url,
      authToken: resolveTwilioConfig()?.authToken,
      required: bridgeAuthRequired(),
      seen,
    });
    if (!auth.ok) {
      log('stream_refused', { reason: auth.reason, callSid: media.callSid });
      ws.close(1008, `stream refused: ${auth.reason}`);
      return;
    }
    const { slug, to } = auth;
    log('stream_authorized', { slug, to, verified: auth.verified, callSid: media.callSid });

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

      // ── Admission (SAU-525): tenant → payer → cap → engine, or a typed refusal.
      const modelId = typeof scenario.metadata?._model === 'string' ? scenario.metadata._model : undefined;
      let admission;
      try {
        admission = await admitInboundCall(store, {
          to,
          modelId,
          fallbackClinicSlug: process.env.TELEPHONY_FALLBACK_CLINIC,
        });
      } catch (e) {
        if (e instanceof CallAdmissionError) {
          log('call_refused', { reason: e.reason, to, message: e.message });
          ws.close(1008, `call refused: ${e.reason}`);
          return;
        }
        throw e;
      }
      const { clinic, ownerUserId, tier, engine, meter, actor } = admission;
      log('call_admitted', {
        clinic: clinic.slug, resolvedBy: admission.resolvedBy, tier, grade: engine.grade,
        engine: engine.model, remainingMinutes: meter.remainingMinutes,
        payerResolvedBy: admission.payerResolvedBy,
      });
      // A payer that moved off the creator surfaces as a signal, not as a wrong bill.
      if (admission.payerResolvedBy === 'earliest_owner' && clinic.createdByUserId) {
        log('payer_fallback', { clinic: clinic.slug, skippedCreator: clinic.createdByUserId, payer: ownerUserId });
      }

      // Everything from here runs AS the clinic owner: the session row, the
      // tenant's authored rules, the outcome + usage writes are all RLS-scoped.
      await runWithActor(actor, async () => {
        const kb = await resolveKnowledgeContext(store, scenario.id, voiceKbCharBudget());
        const compiled = toCompiledScenario(scenario, { knowledgeBaseText: kb.text });
        const voice = resolveOpenAiVoice(scenario.voiceName, process.env.OPENAI_VOICE);
        // The TENANT's clinic definition governs the booking tools, not DEFAULT_CLINIC.
        const clinicConfig = await getClinicConfig(store, ownerUserId, clinic.id);

        const session = await store.createSession({
          scenarioId: scenario.id, userId: ownerUserId, clinicId: clinic.id, vendor: engine.vendor,
        });

        const realtime = new OpenAiRealtimeTransport({
          apiKey,
          model: engine.model,
          instructions: compiled.aiInstructions,
          voice,
          tools: compiled.tools,
        });

        await startCallBridge(media, realtime, {
          scenario,
          store,
          userId: ownerUserId,
          sessionId: session.id,
          actor,
          runTool: (name, argsJson) => runClinicTool(name, safeParse(argsJson), { clinic: clinicConfig }),
          log,
          // Meter (CFO AC on SAU-525): one voice_usage row per call, attributed to the
          // payer at their billing tier, on the engine that actually ran.
          onFinalize: async ({ transcript, startedAt, endedAt, usage }) => {
            const durationMs = Math.max(0, endedAt - startedAt);
            // Close the session row like the web path does (transcript is PHI-enveloped at rest, 0017).
            await store.completeSession(session.id, { status: 'completed', startedAt, endedAt, transcript });
            await store.recordVoiceUsage({
              sessionId: session.id,
              userId: ownerUserId,
              scenarioId: scenario.id,
              vendor: engine.vendor,
              model: engine.model,
              tier,
              engine: engine.model,
              durationMs,
              voiceMinutes: Number((durationMs / 60000).toFixed(4)),
              inputTextTokens: usage?.inputTextTokens ?? 0,
              inputAudioTokens: usage?.inputAudioTokens ?? 0,
              cachedTextTokens: usage?.cachedTextTokens ?? 0,
              cachedAudioTokens: usage?.cachedAudioTokens ?? 0,
              outputTextTokens: usage?.outputTextTokens ?? 0,
              outputAudioTokens: usage?.outputAudioTokens ?? 0,
              totalTokens: usage?.totalTokens ?? 0,
            });
            log('metered', { sessionId: session.id, durationMs, tokens: usage?.totalTokens ?? 0, tier, engine: engine.model });
          },
        });
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
