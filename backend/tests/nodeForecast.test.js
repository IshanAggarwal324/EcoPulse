const { test } = require('node:test');
const assert = require('node:assert');

// Mirrors frontend/hooks/useNodeForecast.js (ESM) pure helpers for the Node
// test runner. Kept in sync with the hook so the logic is covered without a
// browser/DOM test harness.

const summarizeForecast = (predictions = []) => {
  if (!Array.isArray(predictions) || predictions.length === 0) {
    return {
      avgGeneration: 0,
      avgConsumption: 0,
      avgConfidence: 0,
      peakGeneration: 0,
      pointCount: 0,
      generationSeries: [],
    };
  }

  const safe = predictions.map((p) => ({
    generation: Number(p?.predicted_generation) || 0,
    consumption: Number(p?.predicted_consumption) || 0,
    confidence: Number.isFinite(p?.confidence) ? Math.max(0, Math.min(1, p.confidence)) : 0,
  }));

  const len = safe.length;
  return {
    avgGeneration: safe.reduce((s, p) => s + p.generation, 0) / len,
    avgConsumption: safe.reduce((s, p) => s + p.consumption, 0) / len,
    avgConfidence: (safe.reduce((s, p) => s + p.confidence, 0) / len) * 100,
    peakGeneration: safe.reduce((m, p) => Math.max(m, p.generation), 0),
    pointCount: len,
    generationSeries: safe.map((p) => p.generation),
  };
};

const mapForecastsByNodeId = (forecasts = []) => {
  const byNodeId = {};
  if (!Array.isArray(forecasts)) return byNodeId;
  for (const entry of forecasts) {
    const id = entry?.nodeId;
    if (id && Array.isArray(entry.predictions)) {
      byNodeId[String(id)] = entry.predictions;
    }
  }
  return byNodeId;
};

const mkDay = (g, c, conf) => ({
  predicted_generation: g,
  predicted_consumption: c,
  confidence: conf,
});

// ---- summarizeForecast ----------------------------------------------------
test('summarizeForecast returns zeros for empty input', () => {
  const s = summarizeForecast([]);
  assert.strictEqual(s.avgGeneration, 0);
  assert.strictEqual(s.pointCount, 0);
  assert.deepStrictEqual(s.generationSeries, []);
});

test('summarizeForecast returns zeros for non-array input', () => {
  const s = summarizeForecast(null);
  assert.strictEqual(s.avgGeneration, 0);
  assert.strictEqual(s.pointCount, 0);
});

test('summarizeForecast computes averages, peak, and series', () => {
  const s = summarizeForecast([mkDay(10, 4, 0.9), mkDay(20, 6, 0.7)]);
  assert.strictEqual(s.avgGeneration, 15);
  assert.strictEqual(s.avgConsumption, 5);
  assert.strictEqual(s.peakGeneration, 20);
  assert.strictEqual(s.pointCount, 2);
  assert.deepStrictEqual(s.generationSeries, [10, 20]);
  assert.ok(Math.abs(s.avgConfidence - 80) < 1e-9);
});

test('summarizeForecast never produces NaN on malformed entries', () => {
  const s = summarizeForecast([
    { predicted_generation: 'oops', predicted_consumption: null, confidence: 'x' },
    undefined,
    mkDay(5, 2, 1.5), // confidence > 1 clamps to 1
    mkDay(-3, -1, -0.4), // negative numbers handled
  ]);
  assert.strictEqual(Number.isNaN(s.avgGeneration), false);
  assert.strictEqual(Number.isNaN(s.avgConfidence), false);
  assert.deepStrictEqual(s.generationSeries, [0, 0, 5, -3]);
  assert.ok(s.avgConfidence <= 100);
});

test('summarizeForecast clamps confidence to [0,1] bounds', () => {
  const s = summarizeForecast([mkDay(1, 1, 1.5), mkDay(1, 1, -2)]);
  assert.ok(s.avgConfidence - 50 < 1e-9); // (1 + 0)/2 * 100
});

test('summarizeForecast handles numeric strings as numbers', () => {
  const s = summarizeForecast([{ predicted_generation: '12.5', predicted_consumption: '3', confidence: 0.8 }]);
  assert.strictEqual(s.avgGeneration, 12.5);
  assert.strictEqual(s.generationSeries[0], 12.5);
});

// ---- mapForecastsByNodeId -------------------------------------------------
test('mapForecastsByNodeId maps entries by nodeId', () => {
  const out = mapForecastsByNodeId([
    { nodeId: 'n1', nodeName: 'A', predictions: [mkDay(1, 1, 0.9)] },
    { nodeId: 'n2', predictions: [mkDay(2, 2, 0.9)] },
  ]);
  assert.deepStrictEqual(Object.keys(out).sort(), ['n1', 'n2']);
  assert.strictEqual(out.n1.length, 1);
});

test('mapForecastsByNodeId drops entries without nodeId or predictions', () => {
  const out = mapForecastsByNodeId([
    { nodeId: 'n1', predictions: [mkDay(1, 1, 0.9)] },
    { nodeId: null, predictions: [mkDay(1, 1, 0.9)] }, // no id
    { nodeId: 'n3', predictions: 'nope' }, // predictions not array
    { nodeId: 'n4' }, // no predictions
  ]);
  assert.deepStrictEqual(Object.keys(out), ['n1']);
});

test('mapForecastsByNodeId is defensive against non-array input', () => {
  assert.deepStrictEqual(mapForecastsByNodeId(null), {});
  assert.deepStrictEqual(mapForecastsByNodeId(undefined), {});
  assert.deepStrictEqual(mapForecastsByNodeId({}), {});
});

test('mapForecastsByNodeId coerces nodeId to string', () => {
  const out = mapForecastsByNodeId([{ nodeId: 42, predictions: [mkDay(1, 1, 0.9)] }]);
  assert.ok(Object.prototype.hasOwnProperty.call(out, '42'));
});
