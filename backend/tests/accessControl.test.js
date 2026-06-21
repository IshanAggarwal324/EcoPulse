const { test } = require('node:test');
const assert = require('node:assert');
const { mergeForecastPredictions } = require('../utils/forecastMerge');

test('mergeForecastPredictions sums generation and consumption across nodes', () => {
  const ts = '2026-06-22T00:00:00.000Z';
  const merged = mergeForecastPredictions([
    {
      predictions: [{
        timestamp: ts,
        predicted_generation: 10,
        predicted_consumption: 4,
        generation_lower: 8,
        generation_upper: 12,
        consumption_lower: 3,
        consumption_upper: 5,
        confidence: 0.8,
      }],
    },
    {
      predictions: [{
        timestamp: ts,
        predicted_generation: 6,
        predicted_consumption: 2,
        generation_lower: 5,
        generation_upper: 7,
        consumption_lower: 1,
        consumption_upper: 3,
        confidence: 0.6,
      }],
    },
  ]);

  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].predicted_generation, 16);
  assert.strictEqual(merged[0].predicted_consumption, 6);
  assert.strictEqual(merged[0].confidence, 0.7);
});

test('mergeForecastPredictions returns empty array for no forecasts', () => {
  assert.deepStrictEqual(mergeForecastPredictions([]), []);
  assert.deepStrictEqual(mergeForecastPredictions([{ predictions: [] }]), []);
});

test('mergeForecastPredictions sorts by timestamp', () => {
  const merged = mergeForecastPredictions([
    {
      predictions: [
        {
          timestamp: '2026-06-24T00:00:00.000Z',
          predicted_generation: 1,
          predicted_consumption: 1,
          confidence: 0.5,
        },
        {
          timestamp: '2026-06-23T00:00:00.000Z',
          predicted_generation: 2,
          predicted_consumption: 2,
          confidence: 0.5,
        },
      ],
    },
  ]);

  assert.strictEqual(merged.length, 2);
  assert.ok(new Date(merged[0].timestamp) < new Date(merged[1].timestamp));
});
