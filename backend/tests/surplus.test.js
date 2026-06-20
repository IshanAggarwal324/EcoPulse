const { test } = require('node:test');
const assert = require('node:assert');

// Sub-module 2.2 — surplus service pure-logic invariants (no Mongo/Redis/AI).
const { computeSurplus, hoursPerPoint } = require('../services/pricing/surplusService');
const config = require('../config/pricing');

const point = (surplusKw, price, timestamp, hasForecast = true) => ({
  surplusKw,
  pricePerKwhCc: price,
  timestamp,
  hasForecast,
});

/* ------------------------------------------------------------------ */
/* computeSurplus integration over the curve                            */
/* ------------------------------------------------------------------ */

test('computeSurplus sums positive gen-con windows and ignores deficits', () => {
  const points = [
    point(10, 0.05, '2025-01-01T00:00:00Z'), // surplus 10kW * 24h = 240
    point(-4, 0.09, '2025-01-02T00:00:00Z'), // deficit -> skipped
    point(2, 0.07, '2025-01-03T00:00:00Z'),  // surplus 2kW * 24h = 48
  ];
  const r = computeSurplus(points);
  assert.strictEqual(r.totalSurplusKwh, 288); // 240 + 48
  assert.strictEqual(r.surplusPointCount, 2);
  assert.strictEqual(r.peakSurplusKw, 10);
  assert.strictEqual(r.windows.length, 2); // deficit splits the run
});

test('computeSurplus computes an energy-weighted average unit price', () => {
  const points = [
    point(10, 0.05, '2025-01-01T00:00:00Z'), // 240 kWh @ 0.05
    point(10, 0.15, '2025-01-02T00:00:00Z'), // 240 kWh @ 0.15
  ];
  const r = computeSurplus(points);
  // weighted: (0.05*240 + 0.15*240) / 480 = 0.10
  assert.ok(Math.abs(r.weightedAvgPriceCc - 0.1) < 1e-9);
});

test('computeSurplus returns null unit price when there is no surplus', () => {
  const r = computeSurplus([point(-5, 0.1, 't'), point(0, 0.1, 't2')]);
  assert.strictEqual(r.totalSurplusKwh, 0);
  assert.strictEqual(r.weightedAvgPriceCc, null);
  assert.strictEqual(r.windows.length, 0);
});

test('computeSurplus skips no-data forecast points (hasForecast:false)', () => {
  const points = [
    point(10, 0.05, '2025-01-01T00:00:00Z', true),
    point(10, 0.05, '2025-01-02T00:00:00Z', false), // invalid forecast -> skipped
    point(10, 0.05, '2025-01-03T00:00:00Z', true),
  ];
  const r = computeSurplus(points);
  assert.strictEqual(r.surplusPointCount, 2);
  assert.strictEqual(r.totalSurplusKwh, 480); // two 24h windows
  assert.strictEqual(r.windows.length, 2); // gap splits run
});

test('computeSurplus treats NaN/garbage surplus as no contribution', () => {
  const r = computeSurplus([
    point(NaN, 0.1, 't'),
    point('abc', 0.1, 't2'),
    point(5, 0.1, '2025-01-03T00:00:00Z'),
  ]);
  assert.strictEqual(r.surplusPointCount, 1);
  assert.strictEqual(r.peakSurplusKw, 5);
});

test('computeSurplus handles empty / non-array points', () => {
  assert.deepStrictEqual(computeSurplus([]), {
    totalSurplusKwh: 0,
    surplusPointCount: 0,
    peakSurplusKw: 0,
    weightedAvgPriceCc: null,
    windows: [],
  });
  assert.strictEqual(computeSurplus(null).totalSurplusKwh, 0);
});

/* ------------------------------------------------------------------ */
/* hoursPerPoint inference                                              */
/* ------------------------------------------------------------------ */

test('hoursPerPoint infers span from adjacent timestamps', () => {
  assert.strictEqual(
    hoursPerPoint('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-03T00:00:00Z'),
    24,
  );
  assert.strictEqual(hoursPerPoint(null, null, null), 24); // fallback
  assert.strictEqual(hoursPerPoint(undefined, 'bad', undefined), 24); // fallback
});

test('hoursPerPoint uses previous span when no next point', () => {
  assert.strictEqual(
    hoursPerPoint('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', null),
    24,
  );
});

/* ------------------------------------------------------------------ */
/* Config clamps (recommendation bounds)                               */
/* ------------------------------------------------------------------ */

test('recommendation knobs are positive and sane', () => {
  assert.ok(config.getMinSurplusKwh() >= 0);
  assert.ok(config.getMaxRecommendationKwh() > 0);
  assert.ok(config.getRecommendationTtlMinutes() > 0);
  assert.ok(config.getRecommendationHorizonHours() > 0);
  // horizon honors the global hours clamp ceiling.
  assert.ok(config.getRecommendationHorizonHours() <= config.MAX_CURVE_HOURS);
});
