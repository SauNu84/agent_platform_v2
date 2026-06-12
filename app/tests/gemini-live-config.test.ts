/**
 * SAU-259 — Gemini Live browser-transport config.
 *
 * Pure helpers shared by the token route (server) and the browser transport
 * (client): the ephemeral-token request, the WS URL, the voice catalog, and the
 * setup frame. These are the testable invariants of the browser Gemini path; the
 * live socket itself is exercised in the browser (Web Audio + WebSocket).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGeminiVoice, isGeminiVoice, DEFAULT_GEMINI_VOICE,
  geminiAuthTokenUrl, geminiAuthTokenBody, geminiLiveWsUrl, geminiSetupFrame,
} from '@/voice/gemini-live-config';

test('resolveGeminiVoice: valid Gemini voice kept; OpenAI/unknown → env then default', () => {
  assert.equal(resolveGeminiVoice('Puck'), 'Puck');
  assert.equal(isGeminiVoice('Aoede'), true);
  assert.equal(isGeminiVoice('alloy'), false); // OpenAI voice, not Gemini
  // A non-Gemini stored voice (e.g. 'alloy') falls back to the env voice if valid…
  assert.equal(resolveGeminiVoice('alloy', 'Charon'), 'Charon');
  // …else the default. Unknown env is ignored.
  assert.equal(resolveGeminiVoice('alloy', 'not-a-voice'), DEFAULT_GEMINI_VOICE);
  assert.equal(resolveGeminiVoice(undefined), DEFAULT_GEMINI_VOICE);
});

test('geminiAuthTokenUrl embeds the API key (server-only) and hits auth_tokens', () => {
  const url = geminiAuthTokenUrl('SECRET-KEY');
  assert.ok(url.includes('/v1alpha/auth_tokens'));
  assert.ok(url.includes('key=SECRET-KEY'));
  assert.ok(url.startsWith('https://'));
});

test('geminiAuthTokenBody: single-use, connect window shorter than token lifetime', () => {
  const now = 1_700_000_000_000;
  const body = geminiAuthTokenBody(now);
  assert.equal(body.uses, 1);
  const expire = Date.parse(body.expireTime);
  const newSession = Date.parse(body.newSessionExpireTime);
  assert.ok(expire > now, 'token expires in the future');
  assert.ok(newSession > now, 'connect window in the future');
  assert.ok(newSession < expire, 'must connect before the token fully expires');
});

test('geminiLiveWsUrl: wss with the ephemeral access_token and NO api key', () => {
  const url = geminiLiveWsUrl('auth_tokens/ephemeral-abc');
  assert.ok(url.startsWith('wss://'));
  assert.ok(url.includes('BidiGenerateContent'));
  assert.ok(url.includes('access_token=auth_tokens%2Fephemeral-abc'));
  assert.ok(!url.includes('key='), 'the raw API key must never be in the browser WS URL');
});

test('geminiSetupFrame: AUDIO out, chosen voice, system instruction + transcription', () => {
  const frame = geminiSetupFrame({
    model: 'gemini-2.5-flash-preview-native-audio-dialog',
    voice: 'Aoede',
    instructions: 'Be a tough negotiator.',
    tools: [{ name: 'lookup', description: 'd', paramsSchema: { type: 'object' } }],
  }) as { setup: any };
  const s = frame.setup;
  assert.equal(s.model, 'models/gemini-2.5-flash-preview-native-audio-dialog'); // models/ prefix added
  assert.deepEqual(s.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  assert.equal(s.systemInstruction.parts[0].text, 'Be a tough negotiator.');
  assert.ok(s.inputAudioTranscription && s.outputAudioTranscription, 'capture both sides');
  assert.equal(s.tools[0].functionDeclarations[0].name, 'lookup');
});

test('geminiSetupFrame: no tools ⇒ tools omitted; existing models/ prefix preserved', () => {
  const frame = geminiSetupFrame({ model: 'models/gemini-x', voice: 'Puck', instructions: 'hi' }) as { setup: any };
  assert.equal(frame.setup.model, 'models/gemini-x');
  assert.equal(frame.setup.tools, undefined);
});
