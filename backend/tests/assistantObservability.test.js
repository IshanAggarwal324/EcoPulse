const { test } = require('node:test');
const assert = require('node:assert');

// Sub-module 3.4 — observability & report forecast (pure-logic invariants).
// These exercise the in-memory paths / pure helpers; no Redis, Mongo, or Gemini.

const assistantMetrics = require('../services/assistantMetrics');
const { buildSnapshot } = require('../services/assistantSessionStore');
const { mapForecastPredictions } = require('../services/reportService');
const { runHarness } = require('../scripts/eval-assistant');

/* ------------------------------------------------------------------ */
/* Chat analytics (3.4.2) — in-memory fallback path                     */
/* ------------------------------------------------------------------ */

test('recordChat aggregates intent distribution + retrieval hit rate (memory)', async () => {
  assistantMetrics.resetForTests();
  await assistantMetrics.recordChat({ intent: 'bill_analysis', sourceTypes: ['bill'], docIds: [] });
  await assistantMetrics.recordChat({ intent: 'bill_analysis', sourceTypes: ['bill'], docIds: ['trading-guide.md'] });
  await assistantMetrics.recordChat({ intent: 'forecast', sourceTypes: ['forecast'], docIds: [] });
  await assistantMetrics.recordChat({ intent: 'general', sourceTypes: [], docIds: [] }); // miss

  const data = await assistantMetrics.getAnalytics();
  assert.strictEqual(data.totalChats, 4);
  assert.strictEqual(data.retrieval.hits, 3);
  assert.strictEqual(data.retrieval.misses, 1);
  assert.strictEqual(data.retrieval.hitRate, 75); // 3/4
  assert.strictEqual(data.docUsage.chatsWithDocChunks, 1);
  assert.strictEqual(data.docUsage.topDocs[0].docId, 'trading-guide.md');
  const billIntent = data.intentDistribution.find((i) => i.intent === 'bill_analysis');
  assert.strictEqual(billIntent.count, 2);
});

test('analytics never stores content — only counts/keys', async () => {
  assistantMetrics.resetForTests();
  await assistantMetrics.recordChat({
    intent: 'wallet_profit',
    sourceTypes: ['wallet'],
    docIds: [],
  });
  const data = await assistantMetrics.getAnalytics();
  const serialized = JSON.stringify(data);
  // No PII / message / reply fields should exist anywhere in the payload.
  assert.ok(!/message|reply|walletAddress|email/i.test(serialized));
});

test('analytics tolerates null intent and empty arrays', async () => {
  assistantMetrics.resetForTests();
  await assistantMetrics.recordChat({});
  const data = await assistantMetrics.getAnalytics();
  assert.strictEqual(data.totalChats, 1);
  assert.strictEqual(data.intentDistribution[0].intent, 'unknown');
  assert.strictEqual(data.retrieval.misses, 1);
});

/* ------------------------------------------------------------------ */
/* Session store snapshot (3.4.1) — PII-free shape                      */
/* ------------------------------------------------------------------ */

test('buildSnapshot stores only redacted metadata by default', () => {
  const snap = buildSnapshot({
    intent: 'bill_analysis',
    sourceTypes: ['bill', 'doc'],
    docIds: ['billing-and-usage.md'],
    period: '7d',
  });
  assert.strictEqual(snap.intent, 'bill_analysis');
  assert.deepStrictEqual(snap.sourceTypes, ['bill', 'doc']);
  assert.strictEqual(snap.period, '7d');
  assert.ok(typeof snap.ts === 'number');
  // No context payload unless explicitly opted in.
  assert.ok(snap.context === undefined);
});

test('buildSnapshot includes opt-in context payload only when provided', () => {
  const snap = buildSnapshot({ intent: 'faq', contextPayload: { foo: 1 } });
  assert.deepStrictEqual(snap.context, { foo: 1 });
});

test('buildSnapshot caps long arrays defensively', () => {
  const big = Array.from({ length: 50 }, (_, i) => `type-${i}`);
  const snap = buildSnapshot({ intent: 'x', sourceTypes: big, docIds: big });
  assert.ok(snap.sourceTypes.length <= 12);
  assert.ok(snap.docIds.length <= 12);
});

/* ------------------------------------------------------------------ */
/* Report forecast mapping (3.4.4)                                      */
/* ------------------------------------------------------------------ */

test('mapForecastPredictions maps predicted_generation + timestamp', () => {
  const rows = mapForecastPredictions([
    { timestamp: '2026-06-21', predicted_generation: 12.34, predicted_consumption: 5 },
    { timestamp: '2026-06-22', predicted_generation: 7.5 },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].date, '2026-06-21');
  assert.strictEqual(rows[0].predicted, 12.3); // rounded to 1 dp
});

test('mapForecastPredictions drops non-finite / garbage entries', () => {
  const rows = mapForecastPredictions([
    { timestamp: 't1', predicted_generation: 10 },
    { timestamp: 't2', predicted_generation: NaN },
    { timestamp: 't3', predicted_generation: 'oops' },
    null,
    'nope',
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].predicted, 10);
});

test('mapForecastPredictions handles non-array input', () => {
  assert.deepStrictEqual(mapForecastPredictions(null), []);
  assert.deepStrictEqual(mapForecastPredictions(undefined), []);
});

/* ------------------------------------------------------------------ */
/* Evaluation harness (3.4.3)                                           */
/* ------------------------------------------------------------------ */

test('eval harness: all golden questions pass', () => {
  const { passed, total, results } = runHarness();
  assert.strictEqual(passed, total, results.map((r) => `${r.q} => ${r.ok}`).join(' | '));
  for (const r of results) {
    assert.ok(r.docOk, `hybrid doc source missing for "${r.q}"`);
    assert.ok(r.typeOk, `expected source type missing for "${r.q}"`);
  }
});
