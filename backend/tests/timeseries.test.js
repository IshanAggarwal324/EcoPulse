const { test } = require('node:test');
const assert = require('node:assert');
const tsConfig = require('../config/timeseries');
const timeseriesWriter = require('../services/timeseries/timeseriesWriter');
const rollupWorker = require('../workers/rollupWorker');

// ── 1.3 config: defaults preserve pre-1.3 behavior ────────────────────────

test('isTimeseriesEnabled defaults to false (no behavior change)', () => {
  const original = process.env.TIMESERIES_ENABLED;
  delete process.env.TIMESERIES_ENABLED;
  assert.strictEqual(tsConfig.isTimeseriesEnabled(), false);
  if (original !== undefined) process.env.TIMESERIES_ENABLED = original;
});

test('isDualWriteEnabled defaults to true (safe transition state)', () => {
  const original = process.env.TIMESERIES_DUAL_WRITE;
  delete process.env.TIMESERIES_DUAL_WRITE;
  assert.strictEqual(tsConfig.isDualWriteEnabled(), true);
  if (original !== undefined) process.env.TIMESERIES_DUAL_WRITE = original;
});

test('TTL knobs are positive integers', () => {
  assert.ok(tsConfig.RAW_TTL_DAYS > 0);
  assert.ok(tsConfig.ROLLUP_TTL_DAYS > 0);
  assert.ok(tsConfig.FORECAST_LOOKBACK_DAYS > 0);
});

// ── 1.3.1 writer: gating + no-PII meta whitelist ──────────────────────────

test('writeToTimeseries is a no-op when TIMESERIES_ENABLED=false', async () => {
  const original = process.env.TIMESERIES_ENABLED;
  process.env.TIMESERIES_ENABLED = 'false';
  const result = await timeseriesWriter.writeToTimeseries({
    nodeId: '507f1f77bcf86cd799439011',
    energyGenerated: 5,
    energyConsumed: 2,
    timestamp: new Date(),
    source: 'device',
    provenance: { deviceId: 'dev_1' },
  });
  assert.strictEqual(result, null);
  if (original !== undefined) process.env.TIMESERIES_ENABLED = original;
});

test('sanitizeMeta whitelists only nodeId/source/providerKey/deviceId (no PII)', () => {
  const meta = timeseriesWriter.sanitizeMeta(
    '507f1f77bcf86cd799439011',
    'device',
    // Pass extra junk that must be stripped.
    { deviceId: 'dev_1', providerKey: 'smard_de', email: 'user@x.com', wallet: '0xabc', name: 'Alice' },
  );
  assert.deepStrictEqual(Object.keys(meta).sort(), ['deviceId', 'nodeId', 'nodeIdStr', 'providerKey', 'source']);
  assert.strictEqual(meta.email, undefined);
  assert.strictEqual(meta.wallet, undefined);
  assert.strictEqual(meta.name, undefined);
  assert.strictEqual(meta.source, 'device');
});

test('shouldWriteLegacy returns true when TS disabled (source of truth stays legacy)', () => {
  const original = process.env.TIMESERIES_ENABLED;
  process.env.TIMESERIES_ENABLED = 'false';
  assert.strictEqual(timeseriesWriter.shouldWriteLegacy(), true);
  if (original !== undefined) process.env.TIMESERIES_ENABLED = original;
});

test('shouldWriteLegacy respects dual-write flag when TS enabled', () => {
  const origEnabled = process.env.TIMESERIES_ENABLED;
  const origDual = process.env.TIMESERIES_DUAL_WRITE;
  process.env.TIMESERIES_ENABLED = 'true';
  process.env.TIMESERIES_DUAL_WRITE = 'true';
  assert.strictEqual(timeseriesWriter.shouldWriteLegacy(), true);
  process.env.TIMESERIES_DUAL_WRITE = 'false';
  assert.strictEqual(timeseriesWriter.shouldWriteLegacy(), false);
  if (origEnabled !== undefined) process.env.TIMESERIES_ENABLED = origEnabled;
  else delete process.env.TIMESERIES_ENABLED;
  if (origDual !== undefined) process.env.TIMESERIES_DUAL_WRITE = origDual;
  else delete process.env.TIMESERIES_DUAL_WRITE;
});

// ── 1.3.6 rollup worker: hour truncation + no-op when disabled ────────────

test('rollupHour returns ok:false when timeseries disabled', async () => {
  const original = process.env.TIMESERIES_ENABLED;
  process.env.TIMESERIES_ENABLED = 'false';
  const r = await rollupWorker.rollupHour(new Date());
  assert.strictEqual(r.ok, false);
  if (original !== undefined) process.env.TIMESERIES_ENABLED = original;
});

test('rollupWorker.getStatus reports enabled flag consistently', () => {
  const original = process.env.TIMESERIES_ENABLED;
  process.env.TIMESERIES_ENABLED = 'false';
  assert.strictEqual(rollupWorker.getStatus().enabled, false);
  process.env.TIMESERIES_ENABLED = 'true';
  assert.strictEqual(rollupWorker.getStatus().enabled, true);
  if (original !== undefined) process.env.TIMESERIES_ENABLED = original;
  else delete process.env.TIMESERIES_ENABLED;
});
