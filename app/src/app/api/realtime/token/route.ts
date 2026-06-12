/**
 * /api/realtime/token — mint a short-lived client secret for the browser live path.
 *
 * The browser runs the realtime session via the SAME provider seam (client-side),
 * connecting to the vendor's realtime endpoint with an EPHEMERAL token so the
 * platform API key is never exposed to the client. We also hand back the compiled
 * scenario's instructions + voice so the client can configure the session.
 *
 * The engine is resolved from the scenario's author-chosen model (SAU-258) AND the
 * viewer's tier (SAU-256), then this mints the right ephemeral credential per vendor:
 *   - OpenAI  → a Realtime client secret (browser opens a WebRTC call).
 *   - Gemini  → a Live ephemeral auth token (browser opens the BidiGenerateContent
 *               WebSocket directly; SAU-259).
 * When the vendor's key is absent we answer 501 so the client falls back gracefully
 * to the deterministic mock (no crash) — the server-driven Join / text Chat still
 * work for dev/demo with zero credentials.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getScenario } from '@/services/scenarios';
import { resolveKnowledgeContext } from '@/services/knowledge-base';
import { toCompiledScenario } from '@/domain/scenario';
import { resolveOpenAiVoice } from '@/lib/voices';
import { getActor } from '@/services/current-user';
import { resolveTierForUser, resolveSessionEngine, voiceKbCharBudget } from '@/voice/engine-router';
import { getModelApiKeyRaw } from '@/services/settings';
import {
  geminiAuthTokenUrl, geminiAuthTokenBody, geminiLiveWsUrl, resolveGeminiVoice, geminiSetupFrame,
  GEMINI_INPUT_SAMPLE_RATE, GEMINI_OUTPUT_SAMPLE_RATE,
} from '@/voice/gemini-live-config';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { slug } = await req.json().catch(() => ({ slug: undefined }));
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  const scenario = await getScenario(getStore(), slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Multi-model voice router (SAU-256/258): resolve the engine from the scenario's
  // author-chosen model AND the viewer's tier (free downgrades a premium engine).
  const actor = await getActor();
  const tier = await resolveTierForUser(getStore(), actor?.userId ?? null);
  const modelId = typeof scenario.metadata?._model === 'string' ? scenario.metadata._model : undefined;
  const engine = resolveSessionEngine({ modelId, tier });
  const model = engine.model;

  // Fold any linked Knowledge Base (SAU-243) into the live agent's prompt, bounded
  // by the tighter VOICE budget (cost lever #2) for a small, cacheable prefix.
  const kb = await resolveKnowledgeContext(getStore(), scenario.id, voiceKbCharBudget());
  const compiled = toCompiledScenario(scenario, { knowledgeBaseText: kb.text });

  // ── Gemini Live browser transport (SAU-259) ────────────────────────────────
  // Mint a short-lived EPHEMERAL auth token server-side (the GEMINI_API_KEY never
  // reaches the client); the browser opens its own BidiGenerateContent WebSocket
  // with `?access_token=<token>`. No key ⇒ 501 → graceful mock fallback (unchanged).
  if (engine.vendor === 'gemini') {
    // Resolve the key from env first (board's app/.env.local pattern), then fall
    // back to the key the board self-provisioned in Settings → AI Model (SAU-259).
    const geminiKey = process.env.GEMINI_API_KEY ?? (await getModelApiKeyRaw(getStore(), actor?.userId ?? '', 'gemini'));
    if (!geminiKey) {
      return NextResponse.json(
        {
          error: `GEMINI_API_KEY not configured — add a Gemini key in Settings → AI Model ` +
            `(or app/.env.local) to run live ${engine.label}. Falling back to the simulated session.`,
          vendor: 'gemini',
          model,
          tier,
        },
        { status: 501 },
      );
    }
    const tokenResp = await fetch(geminiAuthTokenUrl(geminiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiAuthTokenBody(Date.now())),
    });
    if (!tokenResp.ok) {
      const detail = await tokenResp.text().catch(() => '');
      return NextResponse.json({ error: `failed to mint Gemini token (${tokenResp.status})`, detail }, { status: 502 });
    }
    const tok = await tokenResp.json();
    const token: string = tok.name ?? tok.token ?? tok;
    const voice = resolveGeminiVoice(scenario.voiceName, process.env.GEMINI_VOICE);
    return NextResponse.json({
      vendor: 'gemini',
      model,
      tier,
      wsUrl: geminiLiveWsUrl(token),
      inputSampleRate: GEMINI_INPUT_SAMPLE_RATE,
      outputSampleRate: GEMINI_OUTPUT_SAMPLE_RATE,
      // The client sends this exact setup frame as its first WS message.
      setup: geminiSetupFrame({ model, voice, instructions: compiled.aiInstructions, tools: compiled.tools }),
      scenario: { id: compiled.id, instructions: compiled.aiInstructions, voice },
    });
  }

  // ── OpenAI Realtime browser transport (WebRTC) ─────────────────────────────
  // env first, then the key self-provisioned in Settings → AI Model (SAU-259).
  const apiKey = process.env.OPENAI_API_KEY ?? (await getModelApiKeyRaw(getStore(), actor?.userId ?? '', 'openai'));
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'OPENAI_API_KEY not configured — add an OpenAI key in Settings → AI Model (or app/.env.local). ' +
          'Use the server-driven Join (mock vendor) for dev/demo.',
        vendor: 'openai',
      },
      { status: 501 },
    );
  }

  const resp = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: { type: 'realtime', model } }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return NextResponse.json({ error: `failed to mint client secret (${resp.status})`, detail }, { status: 502 });
  }
  const secret = await resp.json();
  // OpenAI Realtime's `voice` is a plain string from a fixed catalog. Honor the
  // scenario's chosen voice (Appearance tab, SAU-238) when it's a valid OpenAI
  // voice; otherwise fall back to OPENAI_VOICE/alloy (the stored voice may be a
  // non-OpenAI name like 'Aoede', which OpenAI rejects).
  const voice = resolveOpenAiVoice(scenario.voiceName, process.env.OPENAI_VOICE);
  return NextResponse.json({
    vendor: 'openai',
    clientSecret: secret.value ?? secret.client_secret?.value ?? secret,
    model,
    tier,
    scenario: { id: compiled.id, instructions: compiled.aiInstructions, voice, tools: compiled.tools },
  });
}
