const { test } = require('node:test');
const assert = require('node:assert');

const mqttDeviceCache = require('../utils/mqttDeviceCache');
const ingestionMetrics = require('../services/ingestion/ingestionMetrics');
const { computeSurplus } = require('../services/pricing/surplusService');

/* ------------------------------------------------------------------ */
/* H23 — MQTT device cache                                             */
/* ------------------------------------------------------------------ */

test('mqttDeviceCache returns cached device/node until TTL expires', () => {
  mqttDeviceCache.clear();
  const nodeId = '507f1f77bcf86cd799439011';
  const payload = {
    device: { deviceId: 'dev_test', nodeId },
    node: { _id: nodeId, status: 'active' },
  };

  mqttDeviceCache.set(nodeId, payload);
  assert.deepStrictEqual(mqttDeviceCache.get(nodeId), payload);
  assert.strictEqual(mqttDeviceCache.size(), 1);

  mqttDeviceCache.invalidate(nodeId);
  assert.strictEqual(mqttDeviceCache.get(nodeId), null);
});

test('mqttDeviceCache caches negative lookups', () => {
  mqttDeviceCache.clear();
  const nodeId = '507f1f77bcf86cd799439012';
  mqttDeviceCache.set(nodeId, { device: null, node: null });
  const hit = mqttDeviceCache.get(nodeId);
  assert.strictEqual(hit.device, null);
  assert.strictEqual(hit.node, null);
});

/* ------------------------------------------------------------------ */
/* H24 — ingestion rejection persistence throttle                      */
/* ------------------------------------------------------------------ */

test('ingestionMetrics dedupes identical rejections within the dedup window', () => {
  ingestionMetrics.reset();
  process.env.INGESTION_ERROR_PERSIST_MAX = '1000';

  const rejection = {
    kind: 'invalid_json',
    source: 'mqtt',
    nodeId: '507f1f77bcf86cd799439011',
    reason: 'payload is not valid JSON',
  };

  assert.strictEqual(ingestionMetrics.shouldPersistRejection(rejection), true);
  assert.strictEqual(ingestionMetrics.shouldPersistRejection(rejection), false);
  assert.strictEqual(ingestionMetrics.buildDedupKey(rejection), ingestionMetrics.buildDedupKey(rejection));
});

test('ingestionMetrics rate-limits dead-letter persistence', () => {
  ingestionMetrics.reset();
  process.env.INGESTION_ERROR_PERSIST_MAX = '3';

  let allowed = 0;
  for (let i = 0; i < 10; i += 1) {
    if (
      ingestionMetrics.shouldPersistRejection({
        kind: 'invalid_json',
        source: 'mqtt',
        nodeId: `507f1f77bcf86cd7994390${String(i).padStart(2, '0')}`,
        reason: `reason-${i}`,
      })
    ) {
      allowed += 1;
    }
  }

  assert.strictEqual(allowed, 3);
});

/* ------------------------------------------------------------------ */
/* H22 — surplus batching helper (pure path sanity)                    */
/* ------------------------------------------------------------------ */

test('computeSurplus remains pure for recommendation batching', () => {
  const points = [
    { timestamp: '2025-01-01T00:00:00Z', surplusKw: 2, pricePerKwhCc: 0.1, hasForecast: true },
    { timestamp: '2025-01-02T00:00:00Z', surplusKw: 0, pricePerKwhCc: 0.1, hasForecast: true },
  ];
  const out = computeSurplus(points);
  assert.ok(out.totalSurplusKwh > 0);
});
