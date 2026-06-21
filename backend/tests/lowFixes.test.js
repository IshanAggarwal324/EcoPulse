const { test } = require('node:test');
const assert = require('node:assert/strict');
const BlockchainService = require('../services/blockchainService');
const { MAX_KEYS } = require('../middleware/rateLimitMemory');
const ingestionMetrics = require('../services/ingestion/ingestionMetrics');

test('blockchainService exposes contract accessors after lazy ABI load', () => {
  assert.equal(typeof BlockchainService.getEnergyTradingContractReadOnly, 'function');
  assert.equal(typeof BlockchainService.getActiveListings, 'function');
});

test('rate limit memory store max keys is positive', () => {
  assert.ok(MAX_KEYS > 0);
});

test('ingestionMetrics dedup skips repeated identical rejections', () => {
  ingestionMetrics.reset();
  const payload = {
    kind: 'validation',
    source: 'device',
    nodeId: 'abc',
    reason: 'bad payload',
  };
  assert.equal(ingestionMetrics.shouldPersistRejection(payload), true);
  assert.equal(ingestionMetrics.shouldPersistRejection(payload), false);
  ingestionMetrics.reset();
});
