const { test } = require('node:test');
const assert = require('node:assert');

// Sub-module 2.1 — pricing engine pure-logic invariants (no Mongo/Redis/AI).
const pricingEngine = require('../services/pricing/pricingEngine');
const config = require('../config/pricing');

const {
  computeSurplusRatio,
  computePricePoint,
  blendMarketAnchor,
  buildConfidenceBands,
  buildPricingCurve,
  normalizePrediction,
} = pricingEngine;

/* ------------------------------------------------------------------ */
/* Value hygiene (NaN / negative / non-finite rejection)               */
/* ------------------------------------------------------------------ */

test('computeSurplusRatio treats missing/invalid as no-data, not zero', () => {
  assert.strictEqual(computeSurplusRatio(null, 50), null);
  assert.strictEqual(computeSurplusRatio(100, undefined), null);
  assert.strictEqual(computeSurplusRatio(NaN, 50), null);
  assert.strictEqual(computeSurplusRatio(-5, 50), null); // negative -> no-data
  assert.strictEqual(computeSurplusRatio(100, -5), null);
});

test('computeSurplusRatio computes a finite ratio and respects min demand', () => {
  assert.strictEqual(computeSurplusRatio(100, 50), 1); // (100-50)/50
  // consumption below MIN_DEMAND_KWH uses the floor so no divide-by-zero.
  const r = computeSurplusRatio(2, 0);
  assert.ok(Number.isFinite(r));
  assert.ok(r > 0);
});

/* ------------------------------------------------------------------ */
/* Price clamping (floor/ceiling guardrail 2.1.6)                      */
/* ------------------------------------------------------------------ */

test('computePricePoint clamps every output to [floor, ceiling]', () => {
  const floor = config.getPriceFloorCc();
  const ceiling = config.getPriceCeilingCc();

  // Extreme surplus should not push below the floor.
  const surplus = computePricePoint({
    forecastGen: 1_000_000,
    forecastCon: 1,
    historicalAvgUnitPrice: 0.5,
    listedEnergyKw: 1_000_000,
  });
  assert.ok(surplus.price >= floor, `price ${surplus.price} below floor ${floor}`);
  assert.ok(surplus.price <= ceiling);

  // Extreme deficit should not push above the ceiling.
  const deficit = computePricePoint({
    forecastGen: 0,
    forecastCon: 1_000_000,
    historicalAvgUnitPrice: 0.5,
    listedEnergyKw: 0,
  });
  assert.ok(deficit.price <= ceiling, `price ${deficit.price} above ceiling ${ceiling}`);
  assert.ok(deficit.price >= floor);
});

test('computePricePoint rejects NaN forecast and falls back to anchored base', () => {
  const r = computePricePoint({
    forecastGen: NaN,
    forecastCon: 'abc',
    historicalAvgUnitPrice: 0.4,
    listedEnergyKw: 10,
  });
  assert.strictEqual(r.hasForecast, false);
  assert.strictEqual(r.surplusKw, 0);
  assert.ok(Number.isFinite(r.price));
});

/* ------------------------------------------------------------------ */
/* Market anchor blend (70/30 guardrail 2.1.4)                         */
/* ------------------------------------------------------------------ */

test('blendMarketAnchor mixes implied + historical by configured weight', () => {
  const weight = config.getMarketAnchorWeight();
  const blended = blendMarketAnchor(0.1, 0.3);
  const expected = 0.1 * (1 - weight) + 0.3 * weight;
  assert.ok(Math.abs(blended - expected) < 1e-9);
});

test('blendMarketAnchor falls back to default when both inputs missing', () => {
  const blended = blendMarketAnchor(null, null);
  assert.strictEqual(blended, config.getDefaultBasePriceCc());
});

test('blendMarketAnchor uses whichever input is available', () => {
  assert.strictEqual(blendMarketAnchor(0.2, null), 0.2);
  assert.strictEqual(blendMarketAnchor(null, 0.7), 0.7);
});

/* ------------------------------------------------------------------ */
/* Confidence bands widen with low confidence (guardrail 2.1.5)        */
/* ------------------------------------------------------------------ */

test('buildConfidenceBands widen as confidence drops', () => {
  const price = 0.5;
  const high = buildConfidenceBands(price, 0.99);
  const low = buildConfidenceBands(price, 0.3);
  const highSpread = high.confidenceHigh - high.confidenceLow;
  const lowSpread = low.confidenceHigh - low.confidenceLow;
  assert.ok(lowSpread > highSpread, 'low-confidence band must be wider');
  assert.ok(high.confidenceLow <= price && price <= high.confidenceHigh);
  assert.ok(low.confidenceLow <= price && price <= low.confidenceHigh);
});

test('buildConfidenceBands always clamp to [floor, ceiling]', () => {
  const floor = config.getPriceFloorCc();
  const ceiling = config.getPriceCeilingCc();
  const bands = buildConfidenceBands(0.001, 0); // very low price + confidence
  assert.ok(bands.confidenceLow >= floor);
  assert.ok(bands.confidenceHigh <= ceiling);
});

/* ------------------------------------------------------------------ */
/* Full curve assembly                                                 */
/* ------------------------------------------------------------------ */

test('buildPricingCurve clamps all points, exposes algo version fields, rejects bad inputs', () => {
  const floor = config.getPriceFloorCc();
  const ceiling = config.getPriceCeilingCc();

  const predictions = [
    { timestamp: '2025-01-01T00:00:00Z', predicted_generation: 100, predicted_consumption: 50, confidence: 0.9 },
    { timestamp: '2025-01-02T00:00:00Z', predicted_generation: NaN, predicted_consumption: 'x', confidence: 0.4 },
    { timestamp: '2025-01-03T00:00:00Z', predicted_generation: 10, predicted_consumption: 200, confidence: 0.6 },
  ];

  const curve = buildPricingCurve({
    predictions,
    historicalAvgUnitPrice: 0.3,
    listedEnergyKw: 20,
  });

  assert.strictEqual(curve.length, 3);
  for (const point of curve) {
    assert.ok(point.pricePerKwhCc >= floor, 'below floor');
    assert.ok(point.pricePerKwhCc <= ceiling, 'above ceiling');
    assert.ok(point.confidenceLow <= point.pricePerKwhCc);
    assert.ok(point.confidenceHigh >= point.pricePerKwhCc);
    assert.ok(Number.isFinite(point.surplusKw));
    assert.ok(Number.isFinite(point.surplusRatio));
  }

  // Point 0: surplus (gen>con) -> surplusKw positive.
  assert.ok(curve[0].surplusKw > 0);
  assert.ok(curve[0].hasForecast);

  // Point 1: invalid forecast -> no-data fallback.
  assert.strictEqual(curve[1].hasForecast, false);
  assert.strictEqual(curve[1].surplusKw, 0);

  // Point 2: deficit -> no surplus.
  assert.strictEqual(curve[2].surplusKw, 0);
});

test('buildPricingCurve handles empty predictions gracefully', () => {
  const curve = buildPricingCurve({ predictions: [], historicalAvgUnitPrice: null, listedEnergyKw: 0 });
  assert.deepStrictEqual(curve, []);
});

test('normalizePrediction tolerates alternate field names', () => {
  const n = normalizePrediction({ generation: 5, consumption: 2, confidence: 0.8, timestamp: 't' });
  assert.strictEqual(n.forecastGen, 5);
  assert.strictEqual(n.forecastCon, 2);
  assert.strictEqual(n.confidence, 0.8);
});

/* ------------------------------------------------------------------ */
/* Config clamps                                                       */
/* ------------------------------------------------------------------ */

test('clampHours bounds the requested horizon to [1, 168]', () => {
  assert.strictEqual(config.clampHours(24), 24);
  assert.strictEqual(config.clampHours(0), 1);
  assert.strictEqual(config.clampHours(99999), config.MAX_CURVE_HOURS);
  assert.strictEqual(config.clampHours('abc'), 24);
});

test('clampPrice never returns a value outside [floor, ceiling] or non-finite', () => {
  const floor = config.getPriceFloorCc();
  const ceiling = config.getPriceCeilingCc();
  assert.ok(config.clampPrice(NaN) >= floor);
  assert.strictEqual(config.clampPrice(-100), floor);
  assert.strictEqual(config.clampPrice(1e9), ceiling);
});

test('ceiling is always greater than floor (config self-consistency)', () => {
  assert.ok(config.getPriceCeilingCc() > config.getPriceFloorCc());
});

test('algo version is a non-empty semver string surfaced on every curve', () => {
  assert.match(config.PRICING_ALGO_VERSION, /^\d+\.\d+\.\d+/);
});
