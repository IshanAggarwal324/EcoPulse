const { test } = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

// Sub-module 2.3 — auto-trading pure-logic + crypto invariants.
const autoConfig = require('../config/autoTrading');
const listingIntentService = require('../services/pricing/listingIntentService');
const { applyPriceStrategy, clampToIntentBounds } = require('../services/pricing/autoTradingService');

/* ------------------------------------------------------------------ */
/* Config: limits + bucket helpers (fail-closed defaults)              */
/* ------------------------------------------------------------------ */

test('auto-trading fails closed by default (env unset)', () => {
  // When AUTO_TRADING_ENABLED is unset, the matcher must stay off.
  const saved = process.env.AUTO_TRADING_ENABLED;
  delete process.env.AUTO_TRADING_ENABLED;
  assert.strictEqual(autoConfig.isAutoTradingEnvEnabled(), false);
  assert.strictEqual(autoConfig.isAutoSubmitEnabled(), false);
  if (saved !== undefined) process.env.AUTO_TRADING_ENABLED = saved;
});

test('clampMaxListingsPerDay honors the absolute ceiling', () => {
  assert.strictEqual(autoConfig.clampMaxListingsPerDay(0), autoConfig.getMaxListingsPerDayDefault());
  assert.strictEqual(autoConfig.clampMaxListingsPerDay('abc'), autoConfig.getMaxListingsPerDayDefault());
  assert.strictEqual(autoConfig.clampMaxListingsPerDay(5), 5);
  assert.strictEqual(autoConfig.clampMaxListingsPerDay(9999), autoConfig.ABSOLUTE_MAX_LISTINGS_PER_DAY);
});

test('clampMinTimeBetweenMs is never tighter than one matcher interval', () => {
  const interval = autoConfig.getMatcherIntervalMs();
  assert.ok(autoConfig.clampMinTimeBetweenMs(0) >= interval);
  assert.ok(autoConfig.clampMinTimeBetweenMs(50) >= interval);
});

test('dayBucket/hourBucket are stable UTC strings', () => {
  const d = new Date('2025-06-20T13:45:00Z');
  assert.strictEqual(autoConfig.dayBucket(d), '2025-06-20');
  assert.strictEqual(autoConfig.hourBucket(d), '2025-06-20T13');
});

/* ------------------------------------------------------------------ */
/* applyPriceStrategy + clampToIntentBounds (pure)                     */
/* ------------------------------------------------------------------ */

const rec = (energyAmount, unitPriceCc) => ({ energyAmount, unitPriceCc });

test('applyPriceStrategy: forecast_derived uses recommendation price, clamped to bounds', () => {
  const policy = { priceStrategy: 'forecast_derived', fixedDiscountPercent: 5, minUnitPriceCc: null, maxUnitPriceCc: null };
  const out = applyPriceStrategy({ recommendation: rec(100, 0.12), policy });
  assert.ok(Math.abs(out.unitPriceCc - 0.12) < 1e-9);
  assert.strictEqual(out.reason, 'forecast_derived');
  assert.ok(Math.abs(out.totalPriceCc - 12) < 1e-6);
});

test('applyPriceStrategy: fixed_discount shaves percent off, then clamps to policy max', () => {
  const policy = { priceStrategy: 'fixed_discount', fixedDiscountPercent: 10, minUnitPriceCc: null, maxUnitPriceCc: 0.13 };
  const out = applyPriceStrategy({ recommendation: rec(100, 0.2), policy });
  // 0.2 * 0.9 = 0.18, then max bound 0.13 -> 0.13
  assert.ok(Math.abs(out.unitPriceCc - 0.13) < 1e-9);
  assert.strictEqual(out.reason, 'fixed_discount_10pct');
});

test('applyPriceStrategy: fallback base when recommendation unit is garbage', () => {
  const policy = { priceStrategy: 'forecast_derived', fixedDiscountPercent: 0, minUnitPriceCc: null, maxUnitPriceCc: null };
  const out = applyPriceStrategy({ recommendation: rec(10, NaN), policy });
  assert.strictEqual(out.reason, 'fallback_base');
  assert.ok(out.unitPriceCc > 0);
});

test('clampToIntentBounds caps energy + recomputes total, honors maxTotalCc', () => {
  const out = clampToIntentBounds({
    energy: 500,
    unit: 0.1,
    total: 50,
    intent: { maxEnergyKwh: 100, minUnitPriceCc: null, maxUnitPriceCc: null, maxTotalCc: 5 },
  });
  assert.strictEqual(out.energyAmount, 100); // capped
  assert.ok(Math.abs(out.totalPriceCc - 5) < 1e-6); // 100*0.1=10 capped to 5
});

test('clampToIntentBounds floors unit price at intent min', () => {
  const out = clampToIntentBounds({
    energy: 10,
    unit: 0.01,
    total: 0.1,
    intent: { maxEnergyKwh: 1000, minUnitPriceCc: 0.05, maxUnitPriceCc: null, maxTotalCc: null },
  });
  assert.ok(Math.abs(out.unitPriceCc - 0.05) < 1e-9);
});

/* ------------------------------------------------------------------ */
/* EIP-712 listing intent: crypto round-trip (security-critical)       */
/* ------------------------------------------------------------------ */

const sampleBounds = {
  policyId: '507f1f77bcf86cd799439011',
  maxEnergyKwh: 250,
  minUnitPriceCc: 0.04,
  maxUnitPriceCc: 0.15,
  maxTotalCc: 1000,
  expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
  nonce: 7,
};

test('buildTypedData encodes cc prices as micro-CC uint256', () => {
  const td = listingIntentService.buildTypedData(sampleBounds);
  assert.strictEqual(td.primaryType, 'ListingIntent');
  assert.strictEqual(td.message.maxEnergyKwh, 250n);
  assert.strictEqual(td.message.minUnitPriceMicroCc, 40000n); // 0.04 * 1e6
  assert.strictEqual(td.message.maxUnitPriceMicroCc, 150000n); // 0.15 * 1e6
  assert.strictEqual(td.message.nonce, 7n);
});

test('recoverSigner round-trips a real wallet signature', async () => {
  const wallet = ethers.Wallet.createRandom();
  const td = listingIntentService.buildTypedData(sampleBounds);
  const signature = await wallet.signTypedData(td.domain, td.types, td.message);
  const recovered = listingIntentService.recoverSigner(td, signature);
  assert.strictEqual(recovered, wallet.address.toLowerCase());
});

test('verifyIntentSignature passes when signer == wallet, throws on mismatch', async () => {
  const wallet = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom();
  const td = listingIntentService.buildTypedData(sampleBounds);
  const signature = await wallet.signTypedData(td.domain, td.types, td.message);

  const { signer } = listingIntentService.verifyIntentSignature({
    ...sampleBounds,
    signature,
    expectedWallet: wallet.address,
  });
  assert.strictEqual(signer, wallet.address.toLowerCase());

  // A signature from wallet A must NOT verify against wallet B's expected address.
  assert.throws(
    () =>
      listingIntentService.verifyIntentSignature({
        ...sampleBounds,
        signature,
        expectedWallet: other.address,
      }),
    /does not match/i,
  );
});

test('verifyIntentSignature rejects when bounds differ from what was signed', async () => {
  const wallet = ethers.Wallet.createRandom();
  const td = listingIntentService.buildTypedData(sampleBounds);
  const signature = await wallet.signTypedData(td.domain, td.types, td.message);

  // Client claims a higher maxEnergyKwh than it signed -> canonical rebuild differs
  // -> recovered signer won't match (verification effectively fails).
  assert.throws(
    () =>
      listingIntentService.verifyIntentSignature({
        ...sampleBounds,
        maxEnergyKwh: 9999,
        signature,
        expectedWallet: wallet.address,
      }),
  );
});

test('recoverSigner returns null for a malformed signature', () => {
  const td = listingIntentService.buildTypedData(sampleBounds);
  assert.strictEqual(listingIntentService.recoverSigner(td, 'not-a-signature'), null);
  assert.strictEqual(listingIntentService.recoverSigner(td, ''), null);
});

test('micro-CC helpers round-trip without precision loss', () => {
  assert.strictEqual(Number(listingIntentService.toMicroCcUint(0.08)), 80000);
  assert.ok(Math.abs(listingIntentService.microCcToCc(80000n) - 0.08) < 1e-9);
  assert.strictEqual(Number(listingIntentService.toMicroCcUint(null)), 0);
});
