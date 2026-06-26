const { test } = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

/*
 * Module 6.1 — Order Book API tests.
 *
 * Focuses on the security-critical + pure-math paths (no live chain, no DB):
 *   - asks ladder aggregation math (cumulative, bucketing, sanitization)
 *   - bucket clamping (DoS guard)
 *   - buy-order EIP-712 signature verification round-trip
 *   - buy-order bounds / expiry validation (forgery + replay guards)
 *   - graceful degradation on chain outage
 *   - BuyOrderError HTTP status mapping
 */

const { aggregateAsks, clampBuckets, getOrderBookDepth } = require('../services/marketplaceService');
const buyOrderService = require('../services/buyOrderService');

const mkOrder = (unitPrice, energyAmount, price) => ({
  unitPrice,
  energyAmount,
  price: price ?? unitPrice * energyAmount,
});

/* ------------------------------------------------------------------ */
/* aggregateAsks — empty / sanitization                                */
/* ------------------------------------------------------------------ */

test('aggregateAsks returns an empty ladder for no orders', () => {
  const r = aggregateAsks([]);
  assert.deepStrictEqual(r.levels, []);
  assert.strictEqual(r.bestAskUnitPriceCc, 0);
  assert.strictEqual(r.listingCount, 0);
});

test('aggregateAsks ignores non-finite / negative unit prices', () => {
  const r = aggregateAsks([
    mkOrder(NaN, 10),
    mkOrder(-1, 10),
    mkOrder(0.2, 5),
    { unitPrice: 'oops', energyAmount: 3 },
  ]);
  assert.strictEqual(r.listingCount, 1);
  assert.strictEqual(r.levels[0].unitPriceCc, 0.2);
});

/* ------------------------------------------------------------------ */
/* aggregateAsks — distinct price levels + cumulative                  */
/* ------------------------------------------------------------------ */

test('aggregateAsks groups by exact unit price when few levels', () => {
  const r = aggregateAsks([mkOrder(0.1, 10), mkOrder(0.3, 20), mkOrder(0.1, 5)]);
  // Two distinct prices: 0.1 (15 kWh) and 0.3 (20 kWh), ascending.
  assert.strictEqual(r.levels.length, 2);
  assert.strictEqual(r.levels[0].unitPriceCc, 0.1);
  assert.strictEqual(r.levels[0].energyKw, 15);
  assert.strictEqual(r.levels[0].listingCount, 2);
  assert.strictEqual(r.levels[1].unitPriceCc, 0.3);
  assert.strictEqual(r.levels[1].energyKw, 20);

  // Cumulative energy is ascending-depth.
  assert.strictEqual(r.levels[0].cumulativeEnergyKw, 15);
  assert.strictEqual(r.levels[1].cumulativeEnergyKw, 35);

  assert.strictEqual(r.bestAskUnitPriceCc, 0.1);
  assert.strictEqual(r.worstAskUnitPriceCc, 0.3);
  assert.strictEqual(r.totalEnergyKw, 35);
});

test('aggregateAsks buckets a wide spread into at most `buckets` levels', () => {
  const orders = [];
  for (let i = 0; i < 60; i += 1) orders.push(mkOrder(0.01 * (i + 1), 1));
  const r = aggregateAsks(orders, { buckets: 10 });
  assert.ok(r.levels.length <= 10, 'must not exceed requested bucket count');
  assert.ok(r.levels.length > 1, 'must bucket the wide spread');
  // Cumulative must equal total energy.
  const last = r.levels[r.levels.length - 1];
  assert.ok(Math.abs(last.cumulativeEnergyKw - r.totalEnergyKw) < 1e-6);
});

/* ------------------------------------------------------------------ */
/* clampBuckets — DoS guard                                            */
/* ------------------------------------------------------------------ */

test('clampBuckets clamps to [1, MAX] and defaults on garbage', () => {
  assert.strictEqual(clampBuckets(undefined), clampBuckets('garbage'));
  assert.ok(clampBuckets('garbage') >= 1);
  assert.strictEqual(clampBuckets(0), clampBuckets(undefined));
  assert.strictEqual(clampBuckets(-5), clampBuckets(undefined));
  assert.ok(clampBuckets(99999) <= clampBuckets(99999));
  assert.ok(clampBuckets(99999) >= 1);
  assert.strictEqual(clampBuckets(7), 7);
});

/* ------------------------------------------------------------------ */
/* getOrderBookDepth — graceful degradation on chain outage            */
/* ------------------------------------------------------------------ */

test('getOrderBookDepth degrades to an empty book when the chain is unavailable', async () => {
  const depth = await getOrderBookDepth({ buckets: 5 });
  assert.ok(Number.isFinite(depth.midUnitPriceCc));
  assert.ok(Array.isArray(depth.asks.levels));
  assert.ok(Array.isArray(depth.bids.levels));
  assert.strictEqual(typeof depth.computedAt, 'string');
  // Asks should be empty (no chain) but never throw.
  assert.strictEqual(depth.asks.listingCount, 0);
});

/* ------------------------------------------------------------------ */
/* buy-order EIP-712 signature round-trip (forgery guard)              */
/* ------------------------------------------------------------------ */

test('recoverSigner returns the signing wallet for a valid buy-order signature', async () => {
  const wallet = ethers.Wallet.createRandom();
  const typed = buyOrderService.buildTypedData({
    maxEnergyKwh: 100,
    maxUnitPriceCc: 0.5,
    maxTotalCc: 50,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
    nonce: 1,
  });
  const sig = await wallet.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  );
  const recovered = buyOrderService.recoverSigner(typed, sig);
  assert.strictEqual(recovered, wallet.address.toLowerCase());
});

test('recoverSigner rejects malformed signatures', () => {
  const typed = buyOrderService.buildTypedData({
    maxEnergyKwh: 1,
    maxUnitPriceCc: 0.1,
    maxTotalCc: 1,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 60,
    nonce: 0,
  });
  assert.strictEqual(buyOrderService.recoverSigner(typed, 'not-a-signature'), null);
  assert.strictEqual(buyOrderService.recoverSigner(typed, ''), null);
  assert.strictEqual(buyOrderService.recoverSigner(typed, null), null);
});

test('a signature over one set of bounds does not verify for different bounds', async () => {
  const wallet = ethers.Wallet.createRandom();
  const signed = buyOrderService.buildTypedData({
    maxEnergyKwh: 100,
    maxUnitPriceCc: 0.5,
    maxTotalCc: 50,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
    nonce: 1,
  });
  const sig = await wallet.signTypedData(signed.domain, signed.types, signed.message);

  // Attacker declares cheaper bounds but only has a signature for the real ones.
  const declared = buyOrderService.buildTypedData({
    maxEnergyKwh: 1000,
    maxUnitPriceCc: 0.01,
    maxTotalCc: 10,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
    nonce: 1,
  });
  const recovered = buyOrderService.recoverSigner(declared, sig);
  assert.notStrictEqual(recovered, wallet.address.toLowerCase());
});

/* ------------------------------------------------------------------ */
/* validateBounds / validateExpiry — replay & sanity guards            */
/* ------------------------------------------------------------------ */

test('validateBounds rejects non-positive values', () => {
  assert.throws(() => buyOrderService.validateBounds({ maxEnergyKwh: 0, maxUnitPriceCc: 1, maxTotalCc: 1 }));
  assert.throws(() => buyOrderService.validateBounds({ maxEnergyKwh: 1, maxUnitPriceCc: -1, maxTotalCc: 1 }));
  assert.throws(() => buyOrderService.validateBounds({ maxEnergyKwh: 1, maxUnitPriceCc: 1, maxTotalCc: NaN }));
});

test('validateBounds rejects internally contradictory totals', () => {
  // total < unit price => intent can never be matched for even 1 kWh.
  assert.throws(() =>
    buyOrderService.validateBounds({ maxEnergyKwh: 10, maxUnitPriceCc: 5, maxTotalCc: 2 }),
  );
  // total == unit price is allowed (exactly 1 kWh buyable).
  const ok = buyOrderService.validateBounds({ maxEnergyKwh: 1, maxUnitPriceCc: 5, maxTotalCc: 5 });
  assert.strictEqual(ok.total, 5);
});

test('validateBounds caps absurd values', () => {
  assert.throws(() =>
    buyOrderService.validateBounds({
      maxEnergyKwh: buyOrderService.configSurface.MAX_ENERGY_KWH + 1,
      maxUnitPriceCc: 1,
      maxTotalCc: 1,
    }),
  );
});

test('validateExpiry rejects past and too-far-future expiry', () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.throws(() => buyOrderService.validateExpiry(past));
  const tooFar = Math.floor(Date.now() / 1000) + buyOrderService.configSurface.MAX_TTL_SECONDS + 1;
  assert.throws(() => buyOrderService.validateExpiry(tooFar));
});

test('validateExpiry accepts a near-future expiry', () => {
  const soon = Math.floor(Date.now() / 1000) + 60;
  const d = buyOrderService.validateExpiry(soon);
  assert.ok(d instanceof Date && d.getTime() > Date.now());
});

/* ------------------------------------------------------------------ */
/* BuyOrderError — HTTP status mapping                                 */
/* ------------------------------------------------------------------ */

test('BuyOrderError carries a code + statusCode consumed by the error handler', () => {
  const e1 = new buyOrderService.BuyOrderError('bad', 'BUY_ORDER_BAD_SIGNATURE');
  assert.strictEqual(e1.statusCode, 400);
  assert.strictEqual(e1.code, 'BUY_ORDER_BAD_SIGNATURE');

  const e2 = new buyOrderService.BuyOrderError('nf', 'BUY_ORDER_NOT_FOUND', 404);
  assert.strictEqual(e2.statusCode, 404);

  const e3 = new buyOrderService.BuyOrderError('conflict', 'BUY_ORDER_NOT_ACTIVE', 409);
  assert.strictEqual(e3.statusCode, 409);
});
