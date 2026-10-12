import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedger, sumUsage } from '@/voice/openai-usage';

const usage = (inAudio: number, outAudio: number) => ({
  total_tokens: inAudio + outAudio,
  input_token_details: { audio_tokens: inAudio, text_tokens: 0, cached_tokens: 0 },
  output_token_details: { audio_tokens: outAudio, text_tokens: 0 },
});

test('SAU-555: a re-delivered response.done is counted once', () => {
  const l = new UsageLedger();
  assert.equal(l.add({ id: 'resp_1', usage: usage(28, 83) }), true);
  assert.equal(l.add({ id: 'resp_1', usage: usage(28, 83) }), false); // server re-delivery
  assert.equal(l.add({ id: 'resp_2', usage: usage(52, 89) }), true);
  assert.equal(l.perTurn.length, 2);
  assert.equal(l.duplicates, 1);
  assert.equal(sumUsage(l.perTurn).totals.outputAudioTokens, 83 + 89);
});

test('SAU-555: distinct responses with identical usage are both counted', () => {
  const l = new UsageLedger();
  l.add({ id: 'resp_a', usage: usage(10, 10) });
  l.add({ id: 'resp_b', usage: usage(10, 10) });
  assert.equal(l.perTurn.length, 2);
  assert.equal(l.duplicates, 0);
});

test('SAU-555: id-less deliveries are still counted; usage-less ones add nothing', () => {
  const l = new UsageLedger();
  l.add({ usage: usage(5, 5) });
  l.add({ usage: usage(5, 5) });
  l.add({ id: 'resp_x' });
  l.add(undefined);
  assert.equal(l.perTurn.length, 2);
  assert.equal(l.duplicates, 0);
});

test('SAU-555: a usage-less delivery does not shadow a later one with usage', () => {
  const l = new UsageLedger();
  l.add({ id: 'resp_y' });
  l.add({ id: 'resp_y', usage: usage(7, 9) });
  l.add({ id: 'resp_y', usage: usage(7, 9) });
  assert.equal(l.perTurn.length, 1);
  assert.equal(l.duplicates, 1);
});
