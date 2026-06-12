/**
 * /api/realtime/token — mint a short-lived client secret for the browser live path.
 *
 * The browser runs the realtime session via the SAME provider seam (client-side),
 * connecting to OpenAI Realtime with an EPHEMERAL token so the platform API key is
 * never exposed to the client. We also hand back the compiled scenario's
 * instructions + voice so the client can configure the session.
 *
 * Without OPENAI_API_KEY this returns 501 — the server-driven Join path
 * (/api/scenarios/[slug]/sessions) still works via the mock vendor for dev/demo.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/db';
import { getScenario } from '@/services/scenarios';
import { resolveKnowledgeContext } from '@/services/knowledge-base';
import { toCompiledScenario } from '@/domain/scenario';
import { resolveOpenAiVoice } from '@/lib/voices';
import { getActor } from '@/services/current-user';
import { resolveTierForUser, resolveVoiceEngine, voiceKbCharBudget } from '@/voice/engine-router';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'OPENAI_API_KEY not configured. Use the server-driven Join (mock vendor) for dev/demo.' },
      { status: 501 },
    );
  }
  const { slug } = await req.json().catch(() => ({ slug: undefined }));
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  const scenario = await getScenario(getStore(), slug);
  if (!scenario) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Tiered voice router (SAU-256): mint the client secret for the engine this
  // user's billing tier maps to (free → cheaper engine, paid → "Super").
  const actor = await getActor();
  const tier = await resolveTierForUser(getStore(), actor?.userId ?? null);
  const engine = resolveVoiceEngine(tier);
  const model = engine.model;

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
  // Fold any linked Knowledge Base (SAU-243) into the browser-WebRTC agent prompt,
  // bounded by the tighter VOICE budget (cost lever #2) for a small cacheable prefix.
  const kb = await resolveKnowledgeContext(getStore(), scenario.id, voiceKbCharBudget());
  const compiled = toCompiledScenario(scenario, { knowledgeBaseText: kb.text });
  // OpenAI Realtime's `voice` is a plain string from a fixed catalog. Honor the
  // scenario's chosen voice (Appearance tab, SAU-238) when it's a valid OpenAI
  // voice; otherwise fall back to OPENAI_VOICE/alloy (the stored voice may be a
  // non-OpenAI name like 'Aoede', which OpenAI rejects).
  const voice = resolveOpenAiVoice(scenario.voiceName, process.env.OPENAI_VOICE);
  return NextResponse.json({
    clientSecret: secret.value ?? secret.client_secret?.value ?? secret,
    model,
    tier,
    scenario: { id: compiled.id, instructions: compiled.aiInstructions, voice, tools: compiled.tools },
  });
}
