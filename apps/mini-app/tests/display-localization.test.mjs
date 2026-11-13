import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localizeServerDisplay, historySummary } from '../src/display.ts';
import { createWireMap } from '../src/wire-map.ts';

// Renderer inputs only. These are not proposed one-decimal wire DTOs/fixtures.
const protocol = error => error.kind === 'protocol' && error.code === 'RESPONSE_INVARIANT_FAILED';

test('renderer localizes a supplied one-decimal server string without padding or rounding', () => {
  assert.equal(localizeServerDisplay('2.4', ','), '2,4');
  assert.equal(localizeServerDisplay('10.0', ','), '10,0');
  assert.equal(localizeServerDisplay('2.4', '.'), '2.4');
});

test('renderer preserves additional server digits until the owner changes display precision', () => {
  assert.equal(localizeServerDisplay('2.35', ','), '2,35');
  assert.equal(localizeServerDisplay('1.005', ','), '1,005');
  assert.equal(localizeServerDisplay('1.00', ','), '1,00');
});

test('renderer preserves every large-value digit and never derives positivity from displayed zero', () => {
  assert.equal(localizeServerDisplay('900719925474099312345678901234567890.0', ','),
    '900719925474099312345678901234567890,0');
  assert.equal(localizeServerDisplay('0.0', ','), '0,0');
  assert.equal(localizeServerDisplay('0.00', ','), '0,00');
});

test('history localizes supplied display text and keeps nonofficial attribution and nullable bonus', () => {
  const result = { earned: '2.4', maximum: '10.0', percentage: '24.00', bonus: null, note: '', reviewMessage: '' };
  const before = structuredClone(result);
  assert.equal(historySummary(result, false, ','), 'Tarixiy natija, rasmiy emas · 2,4 / 10,0');
  assert.equal(historySummary(result, true, '.'), 'Rasmiy natija · 2.4 / 10.0');
  assert.equal(historySummary(null, false, ','), 'Rasmiy natija yo‘q');
  assert.deepEqual(result, before);
});

test('renderer rejects numbers, exponents, whitespace and trailing line terminators instead of numeric fallback', () => {
  for (const value of [2.4, null, undefined, '2', '2,4', '02.4', '-0.0', '1e3', ' 2.4', '2.4 ',
    '2.4\n', '2.4\r', '2.4\u2028', '2.4\u2029']) {
    assert.throws(() => localizeServerDisplay(value, ','), protocol);
  }
});

test('owner-pinned point guard accepts1dp only; percentage remains2dp', () => {
  const packet = JSON.parse(readFileSync(new URL('./fixtures/wire.json', import.meta.url), 'utf8'));
  assert.equal(packet.contract_sha256, '280503a6a306c62e60dacea8a067137b37bcde151e6c2101d0beb4cbe09a25eb');
  const source = structuredClone(packet.cases.ordinaryResult.data);
  const mapper = createWireMap({ assetUrl: value => value });
  assert.equal(mapper.result(source, source.attempt_id).earned, '1.5');
  source.ordinary.display.earned_points = '1.50';
  assert.throws(() => mapper.result(source, source.attempt_id), protocol);
});
