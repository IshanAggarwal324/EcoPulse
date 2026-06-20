const { test } = require('node:test');
const assert = require('node:assert');

// Sub-module 2.4.1 — order-book → pricing feedback loop (pure math, no I/O).
const pricingEngine = require('../services/pricing/pricingEngine');
const config = require('../config/pricing');

const { resolveMarketAnchor, computePricePoint, buildPricingCurve } = pricingEngine;

/* ------------------------------------------------------------------ */
/* resolveMarketAnchor — order-book anchor feedback                    */
/* ------------------------------------------------------------------ */

test('resolveMarketAnchor blends historical + live book by the configured weight', () => {
  const w = config.getOrderBookAnchorWeight();
  const blended = resolveMarketAnchor(0.1, 0.5);
  const expected = 0.1 * (1 - w) + 0.5 * w;
  assert.ok(Math.abs(blended - expected) < 1e-9);
});

test('resolveMarketAnchor falls back to whichever signal is available', () => {
  assert.strictEqual(resolveMarketAnchor(0.3, null), 0.3);
  assert.strictEqual(resolveMarketAnchor(null, 0.7), 0.7);
  assert.strictEqual(resolveMarketAnchor(null, null), config.getDefaultBasePriceCc());
});

test('resolveMarketAnchor ignores non-finite book values', () => {
  // NaN/0 book -> falls back to historical only (avg unit price of 0 is "no book").
  assert.strictEqual(resolveMarketAnchor(0.4, 0), 0.4);
  assert.strictEqual(resolveMarketAnchor(0.4, NaN), 0.4);
});

/* ------------------------------------------------------------------ */
/* computePricePoint — book anchor lifts the base price                */
/* ------------------------------------------------------------------ */

test('computePricePoint: a higher live book anchor raises the price floor', () => {
  const low = computePricePoint({
    forecastGen: 100,
    forecastCon: 100, // neutral surplus ratio
    historicalAvgUnitPrice: 0.1,
    listedEnergyKw: 0,
    bookAvgUnitPriceCc: 0.1,
  });
  const high = computePricePoint({
    forecastGen: 100,
    forecastCon: 100,
    historicalAvgUnitPrice: 0.1,
    listedEnergyKw: 0,
    bookAvgUnitPriceCc: 0.9,
  });
  assert.ok(high.price > low.price, 'higher book anchor must raise the price');
});

test('computePricePoint: omitted book anchor behaves like the legacy path', () => {
  const withBookNull = computePricePoint({
    forecastGen: 100,
    forecastCon: 100,
    historicalAvgUnitPrice: 0.2,
    listedEnergyKw: 5,
    bookAvgUnitPriceCc: null,
  });
  const omitted = computePricePoint({
    forecastGen: 100,
    forecastCon: 100,
    historicalAvgUnitPrice: 0.2,
    listedEnergyKw: 5,
  });
  assert.ok(Math.abs(withBookNull.price - omitted.price) < 1e-9);
});

/* ------------------------------------------------------------------ */
/* buildPricingCurve — threads the book anchor through every point     */
/* ------------------------------------------------------------------ */

test('buildPricingCurve threads bookAvgUnitPriceCc without breaking clamps', () => {
  const floor = config.getPriceFloorCc();
  const ceiling = config.getPriceCeilingCc();

  const curve = buildPricingCurve({
    predictions: [
      { timestamp: '2025-01-01T00:00:00Z', predicted_generation: 80, predicted_consumption: 80, confidence: 0.9 },
    ],
    historicalAvgUnitPrice: 0.2,
    listedEnergyKw: 10,
    bookAvgUnitPriceCc: 0.6,
  });

  assert.strictEqual(curve.length, 1);
  for (const p of curve) {
    assert.ok(p.pricePerKwhCc >= floor);
    assert.ok(p.pricePerKwhCc <= ceiling);
  }
});

/* ------------------------------------------------------------------ */
/* marketplaceService.getMarketDepth — depth metric shape              */
/* ------------------------------------------------------------------ */

test('getMarketDepth returns a normalized empty snapshot when the chain is unavailable', async () => {
  // Force the chain call to throw by requiring the service without env.
  const { getMarketDepth } = require('../services/marketplaceService');
  const depth = await getMarketDepth({ limit: 5 });
  assert.ok(Number.isFinite(depth.totalEnergyKw));
  assert.ok(Number.isFinite(depth.listingCount));
  assert.ok(depth.listingCount >= 0);
  assert.strictEqual(typeof depth.computedAt, 'string');
});
