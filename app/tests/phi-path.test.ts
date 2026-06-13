import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPhiScenario, resolvePhiVoiceCredential, PHI_ENV } from '@/voice/phi-path';

test('isPhiScenario only treats metadata._phi === true as PHI (fail-safe default)', () => {
  assert.equal(isPhiScenario({ _phi: true }), true);
  assert.equal(isPhiScenario({ _phi: false }), false);
  assert.equal(isPhiScenario({}), false);
  assert.equal(isPhiScenario(null), false);
  assert.equal(isPhiScenario(undefined), false);
  // truthy-but-not-true values do NOT enable PHI
  assert.equal(isPhiScenario({ _phi: 'true' as unknown as boolean }), false);
  assert.equal(isPhiScenario({ _phi: 1 as unknown as boolean }), false);
});

test('Gemini is refused on the PHI path (422) regardless of env', () => {
  const r = resolvePhiVoiceCredential('gemini', {
    [PHI_ENV.ZDR_CONFIRMED]: 'true',
    [PHI_ENV.KEY]: 'sk-phi',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
});

test('PHI voice refused (403) when ZDR is not confirmed in writing', () => {
  const r = resolvePhiVoiceCredential('openai', {
    [PHI_ENV.KEY]: 'sk-phi-prod',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error ?? '', /Zero-Data-Retention/);
});

test('PHI voice refused (403) when the dedicated prod key is missing — never downgrades', () => {
  const r = resolvePhiVoiceCredential('openai', {
    [PHI_ENV.ZDR_CONFIRMED]: 'true',
    OPENAI_API_KEY: 'sk-consumer-should-never-be-used',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  // crucial: it does NOT fall back to the consumer key
  assert.notEqual(r.apiKey, 'sk-consumer-should-never-be-used');
  assert.equal(r.apiKey, undefined);
});

test('PHI voice resolves the dedicated BAA+ZDR key only when both flag and key are set', () => {
  const r = resolvePhiVoiceCredential('openai', {
    [PHI_ENV.ZDR_CONFIRMED]: '1',
    [PHI_ENV.KEY]: 'sk-phi-prod-org',
    OPENAI_API_KEY: 'sk-consumer',
  });
  assert.equal(r.ok, true);
  assert.equal(r.apiKey, 'sk-phi-prod-org');
});
