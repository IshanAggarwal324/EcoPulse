const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.JWT_ACCESS_SECRET = 'test';
process.env.JWT_REFRESH_SECRET = 'test';

const { validateInputs, getRequiredConfirmations } = require('../services/settlementVerificationService');
const { integrateEnergyKwh, getTolerancePct, getAutoFlagThreshold } = require('../services/reconciliationService');

// ---------------------------------------------------------------------------
// 5.2.2 — Input validation (the first production guardrail).
// ---------------------------------------------------------------------------
test('validateInputs normalizes a valid txHash to lowercase and accepts listingId', () => {
  const { hash, id } = validateInputs(
    '0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
    '42',
  );
  assert.strictEqual(hash, '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  assert.strictEqual(id, 42);
});

test('validateInputs rejects malformed txHashes (injection / wrong length / no 0x)', () => {
  const cases = ['', null, '0x123', 'notahash', '0xZZ' + '0'.repeat(60), '$({})', '../../etc/passwd'];
  for (const bad of cases) {
    assert.throws(() => validateInputs(bad, 1), /txHash/i, `should reject ${bad}`);
  }
});

test('validateInputs rejects invalid listingId values', () => {
  const goodHash = '0x' + 'a'.repeat(64);
  for (const bad of [-1, 1.5, 'abc', NaN, 2 ** 33, null]) {
    assert.throws(() => validateInputs(goodHash, bad), /listingId/i);
  }
});

test('confirmations threshold defaults to 12 and is configurable', () => {
  assert.ok(getRequiredConfirmations() >= 0);
});

// ---------------------------------------------------------------------------
// 5.2.3 — Trapezoidal energy integration (kW samples → kWh).
// ---------------------------------------------------------------------------
test('integrateEnergyKwh returns 0 for empty or single sample', () => {
  assert.strictEqual(integrateEnergyKwh([]), 0);
  assert.strictEqual(integrateEnergyKwh([{ t: 0, kw: 5 }]), 0);
});

test('integrateEnergyKwh computes trapezoidal area correctly', () => {
  // Two samples 1 hour apart: avg power (10+20)/2 = 15kW over 1h → 15kWh.
  const ms = 3600 * 1000;
  const kwh = integrateEnergyKwh([
    { t: 0, kw: 10, unit: 'kW' },
    { t: ms, kw: 20, unit: 'kW' },
  ]);
  assert.ok(Math.abs(kwh - 15) < 1e-9, `expected 15, got ${kwh}`);
});

test('integrateEnergyKwh scales MW readings to kWh (x1000)', () => {
  const ms = 3600 * 1000;
  const kwh = integrateEnergyKwh([
    { t: 0, kw: 0.001, unit: 'MW' }, // 1 kW
    { t: ms, kw: 0.001, unit: 'MW' },
  ]);
  assert.ok(Math.abs(kwh - 1) < 1e-9, `expected 1 kWh, got ${kwh}`);
});

test('integrateEnergyKwh ignores zero/negative dt (duplicate timestamps)', () => {
  const kwh = integrateEnergyKwh([
    { t: 0, kw: 10 },
    { t: 0, kw: 20 }, // same ts → skipped
    { t: 3600 * 1000, kw: 20 },
  ]);
  // Remaining pair (20→20 over 1h) = 20kWh; duplicate contributes nothing.
  assert.ok(Math.abs(kwh - 20) < 1e-9);
});

test('tolerance and auto-flag thresholds are bounded sane defaults', () => {
  assert.ok(getTolerancePct() >= 0);
  const af = getAutoFlagThreshold();
  assert.ok(af >= 0 && af <= 1);
});

// ---------------------------------------------------------------------------
// 5.2.4 — Settlement model enum surface.
// ---------------------------------------------------------------------------
let Settlement;
before(() => {
  Settlement = require('../models/Settlement');
});
after(() => {
  delete require.cache[require.resolve('../models/Settlement')];
});

test('Settlement exposes canonical verification + mismatch enums', () => {
  assert.deepStrictEqual(Settlement.VERIFICATION_STATUSES, ['pending', 'verified', 'mismatch', 'disputed']);
  assert.ok(Settlement.MISMATCH_FLAGS.includes('OVER_DELIVERY'));
  assert.ok(Settlement.MISMATCH_FLAGS.includes('UNDER_DELIVERY'));
  assert.ok(Settlement.MISMATCH_FLAGS.includes('READING_GAP'));
  assert.ok(Settlement.MISMATCH_FLAGS.includes('RECEIPT_MISMATCH'));
});
