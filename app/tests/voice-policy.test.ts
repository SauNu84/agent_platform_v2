import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVoicePolicy,
  voicePolicyForPlan,
  DEFAULT_FREE_SESSION_MAX,
  DEFAULT_PAID_SESSION_MAX,
} from '@/voice/voice-policy';

test('free tier seeds the CPO default policy: 30 / 10 / mini / text_chat_fallback', () => {
  const p = resolveVoicePolicy('free');
  assert.equal(p.tier, 'free');
  assert.equal(p.voiceMinutesPerMonth, 30);
  assert.equal(p.voiceSessionMaxMinutes, DEFAULT_FREE_SESSION_MAX);
  assert.equal(p.voiceSessionMaxMinutes, 10);
  assert.equal(p.voiceEngine, 'gpt-realtime-mini');
  assert.equal(p.onExhausted, 'text_chat_fallback');
});

test('paid tier is uncapped monthly (metered) with the Super engine + 25-min session cap', () => {
  const p = resolveVoicePolicy('paid');
  assert.equal(p.tier, 'paid');
  assert.equal(p.voiceMinutesPerMonth, null, 'paid is metered with overage, no hard monthly cap');
  assert.equal(p.voiceSessionMaxMinutes, DEFAULT_PAID_SESSION_MAX);
  assert.equal(p.voiceEngine, 'gpt-realtime');
});

test('billing plan tier maps to the right voice policy', () => {
  assert.equal(voicePolicyForPlan('free').tier, 'free');
  assert.equal(voicePolicyForPlan(undefined).tier, 'free', 'absent ⇒ safe free default');
  assert.equal(voicePolicyForPlan('standard').tier, 'paid');
  assert.equal(voicePolicyForPlan('premium').tier, 'paid');
});

test('policy is config-driven: env overrides the seed values', () => {
  const prev = {
    budget: process.env.VOICE_FREE_MINUTE_BUDGET,
    sess: process.env.VOICE_FREE_SESSION_MAX,
    eng: process.env.VOICE_ENGINE_FREE,
  };
  try {
    process.env.VOICE_FREE_MINUTE_BUDGET = '45';
    process.env.VOICE_FREE_SESSION_MAX = '15';
    process.env.VOICE_ENGINE_FREE = 'some-cheaper-engine';
    const p = resolveVoicePolicy('free');
    assert.equal(p.voiceMinutesPerMonth, 45);
    assert.equal(p.voiceSessionMaxMinutes, 15);
    assert.equal(p.voiceEngine, 'some-cheaper-engine');
  } finally {
    process.env.VOICE_FREE_MINUTE_BUDGET = prev.budget;
    process.env.VOICE_FREE_SESSION_MAX = prev.sess;
    process.env.VOICE_ENGINE_FREE = prev.eng;
    if (prev.budget === undefined) delete process.env.VOICE_FREE_MINUTE_BUDGET;
    if (prev.sess === undefined) delete process.env.VOICE_FREE_SESSION_MAX;
    if (prev.eng === undefined) delete process.env.VOICE_ENGINE_FREE;
  }
});
