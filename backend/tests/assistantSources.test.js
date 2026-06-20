const { test } = require('node:test');
const assert = require('node:assert');

// Sub-module 3.3.3 — source attribution normalization (pure logic).
const { normalizeSources } = require('../controllers/assistantController');

test('normalizeSources ensures every source has type + label', () => {
  const out = normalizeSources([{ type: 'bill' }, { label: 'Forecast' }]);
  assert.strictEqual(out[0].type, 'bill');
  assert.ok(out[0].label.length > 0);
  assert.strictEqual(out[1].type, 'analytics'); // defaulted
  assert.strictEqual(out[1].label, 'Forecast');
});

test('normalizeSources dedups by type:label', () => {
  const out = normalizeSources([
    { type: 'doc', label: 'Trading Guide' },
    { type: 'doc', label: 'Trading Guide' },
    { type: 'doc', label: 'Billing' },
  ]);
  assert.strictEqual(out.length, 2);
});

test('normalizeSources preserves docId on doc sources', () => {
  const out = normalizeSources([{ type: 'doc', label: 'X', docId: 'trading-guide.md' }]);
  assert.strictEqual(out[0].docId, 'trading-guide.md');
});

test('normalizeSources caps at six sources', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ type: 'reading', label: `node-${i}` }));
  assert.strictEqual(normalizeSources(many).length, 6);
});

test('normalizeSources drops garbage entries', () => {
  const out = normalizeSources([null, undefined, 'nope', { type: 'trade', label: 'Stats' }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'trade');
});

test('normalizeSources handles non-array input', () => {
  assert.deepStrictEqual(normalizeSources(null), []);
  assert.deepStrictEqual(normalizeSources(undefined), []);
});
