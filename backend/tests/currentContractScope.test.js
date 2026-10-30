const { test } = require('node:test');
const assert = require('node:assert/strict');

const Trade = require('../models/Trade');
const { currentTradingContractFilter } = require('../utils/currentContract');
const marketplaceService = require('../services/marketplaceService');
const tradeAggregationService = require('../services/tradeAggregationService');

/*
 * Listing ids restart at 0 whenever the EnergyTrading contract is redeployed.
 * Lookups that find a trade by listing id alone would then return a row from the
 * previous contract. These tests pin the scoping that prevents that.
 */

const NEW_CONTRACT = '0xAbCdEf0000000000000000000000000000000001';
const withEnv = async (value, fn) => {
  const original = process.env.ENERGY_TRADING_ADDRESS;
  if (value === undefined) delete process.env.ENERGY_TRADING_ADDRESS;
  else process.env.ENERGY_TRADING_ADDRESS = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.ENERGY_TRADING_ADDRESS;
    else process.env.ENERGY_TRADING_ADDRESS = original;
  }
};

test('the filter uses the lower-cased configured contract address', async () => {
  await withEnv(NEW_CONTRACT, () => {
    assert.deepEqual(currentTradingContractFilter(), { contractAddress: NEW_CONTRACT.toLowerCase() });
  });
});

test('the filter is empty (no restriction) when no contract is configured', async () => {
  await withEnv(undefined, () => assert.deepEqual(currentTradingContractFilter(), {}));
  await withEnv('   ', () => assert.deepEqual(currentTradingContractFilter(), {}));
});

test('aggregated trades only read the current contract for purchases and listings', async () => {
  const queries = [];
  const original = Trade.find;
  Trade.find = (query) => {
    queries.push(query);
    const chain = {
      sort: () => chain,
      limit: () => chain,
      lean: async () => (query.eventType === 'purchased'
        ? [{ listingId: 3, energyAmount: 10, price: '5', buyer: '0xb', seller: '0xs', blockTimestamp: '2026-10-01T00:00:00Z' }]
        : []),
    };
    return chain;
  };
  try {
    await withEnv(NEW_CONTRACT, () => tradeAggregationService.getAggregatedTrades({}));
  } finally {
    Trade.find = original;
  }

  const purchases = queries.find((q) => q.eventType === 'purchased');
  const listed = queries.find((q) => q.eventType === 'listed');
  assert.equal(purchases.contractAddress, NEW_CONTRACT.toLowerCase());
  assert.equal(listed.contractAddress, NEW_CONTRACT.toLowerCase());
  assert.deepEqual(listed.listingId, { $in: [3] });
});

test('order detail looks up trade events on the current contract only', async () => {
  const BlockchainService = require('../services/blockchainService');
  const originalGet = BlockchainService.getListingById;
  const originalFind = Trade.find;
  let seen = null;
  BlockchainService.getListingById = async () => ({
    id: 4, seller: '0xs', energyAmount: '10', price: '1', status: 'active', isActive: true, createdAt: 1_700_000_000,
  });
  Trade.find = (query) => {
    seen = query;
    // Abort after capturing the query: the rest of getOrderById needs a database.
    const chain = { sort: () => chain, lean: async () => { throw new Error('stop-after-query'); } };
    return chain;
  };
  try {
    await withEnv(NEW_CONTRACT, async () => {
      await assert.rejects(() => marketplaceService.getOrderById(4), /stop-after-query/);
    });
  } finally {
    BlockchainService.getListingById = originalGet;
    Trade.find = originalFind;
  }
  assert.equal(seen.listingId, 4);
  assert.equal(seen.contractAddress, NEW_CONTRACT.toLowerCase());
});
