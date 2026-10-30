const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const Trade = require('../models/Trade');
const SyncState = require('../models/SyncState');
const BlockchainService = require('../services/blockchainService');
const auditService = require('../services/auditService');
const sync = require('../services/blockchainSyncService');

/*
 * The trade sync used to issue one eth_getLogs request PER EVENT TYPE per block
 * chunk (5 requests), and re-split every oversized chunk from scratch. On a
 * throttled free-tier RPC that makes catching up after downtime so slow the
 * health check reports "lagging" for long stretches.
 *
 * These tests use a real ethers Contract with the real event definitions and a
 * fake provider, so they count the actual requests that would hit the RPC.
 */

const ABI = [
  'event EnergyListed(uint256 indexed listingId, address indexed seller, uint256 energyAmount, uint256 price)',
  'event EnergyListedWithExpiry(uint256 indexed listingId, address indexed seller, uint256 energyAmount, uint256 price, uint256 expiresAt)',
  'event EnergyPurchased(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 energyAmount, uint256 price)',
  'event ListingCancelled(uint256 indexed listingId, address indexed seller)',
  'event ListingExpired(uint256 indexed listingId, address indexed seller)',
];
const ADDRESS = '0x' + '2'.repeat(40);
const BUYER = '0x' + 'b'.repeat(40);
const SELLER = '0x' + 'c'.repeat(40);
const iface = new ethers.Interface(ABI);

const makeLog = (eventName, args, blockNumber, index = 0) => {
  const fragment = iface.getEvent(eventName);
  const { data, topics } = iface.encodeEventLog(fragment, args);
  return {
    address: ADDRESS,
    blockNumber,
    blockHash: '0x' + 'd'.repeat(64),
    transactionHash: '0x' + String(blockNumber).padStart(64, '0'),
    transactionIndex: 0,
    index,
    removed: false,
    data,
    topics,
  };
};

const stubEnvironment = async ({ head, cursor, getLogs, fn, chunkSize = 500 }) => {
  const originals = {
    factory: BlockchainService.getEnergyTradingContractReadOnly,
    findOneAndUpdate: SyncState.findOneAndUpdate,
    updateOne: Trade.updateOne,
    resolveActor: auditService.resolveActorFromWallet,
    audit: auditService.log,
    address: process.env.ENERGY_TRADING_ADDRESS,
    delay: process.env.BLOCKCHAIN_SYNC_CHUNK_DELAY_MS,
    chunk: process.env.BLOCKCHAIN_SYNC_CHUNK_SIZE,
  };

  const requests = [];
  const trades = [];
  const state = {
    key: 'energy_trading',
    chainId: 11155111,
    contractAddress: ADDRESS,
    lastSyncedBlock: cursor,
    save: async () => state,
  };

  process.env.ENERGY_TRADING_ADDRESS = ADDRESS;
  process.env.BLOCKCHAIN_SYNC_CHUNK_DELAY_MS = '0';
  process.env.BLOCKCHAIN_SYNC_CHUNK_SIZE = String(chunkSize);

  const provider = {
    getNetwork: async () => ({ chainId: 11155111n }),
    getBlockNumber: async () => head,
    getBlock: async () => ({ timestamp: 1_700_000_000 }),
    getLogs: async (filter) => {
      requests.push(filter);
      return getLogs(filter);
    },
  };
  const contract = new ethers.Contract(ADDRESS, ABI, { provider });

  BlockchainService.getEnergyTradingContractReadOnly = () => contract;
  SyncState.findOneAndUpdate = async () => state;
  Trade.updateOne = async (query, update) => {
    trades.push(update.$setOnInsert);
    return { upsertedCount: 1 };
  };
  auditService.resolveActorFromWallet = async () => null;
  auditService.log = async () => {};

  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    await fn({ requests, trades, state });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    BlockchainService.getEnergyTradingContractReadOnly = originals.factory;
    SyncState.findOneAndUpdate = originals.findOneAndUpdate;
    Trade.updateOne = originals.updateOne;
    auditService.resolveActorFromWallet = originals.resolveActor;
    auditService.log = originals.audit;
    for (const [key, value] of [
      ['ENERGY_TRADING_ADDRESS', originals.address],
      ['BLOCKCHAIN_SYNC_CHUNK_DELAY_MS', originals.delay],
      ['BLOCKCHAIN_SYNC_CHUNK_SIZE', originals.chunk],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const topicsOf = (filter) => filter.topics[0];
const rangeOf = (filter) => Number(filter.toBlock) - Number(filter.fromBlock) + 1;

test('a sync chunk makes ONE eth_getLogs request covering every trade event type', async () => {
  sync._testing.resetAdaptiveChunkCap();
  await stubEnvironment({
    head: 1000,
    cursor: 900,
    getLogs: async () => [],
    fn: async ({ requests }) => {
      await sync.syncBlockchainTrades();

      assert.equal(requests.length, 1, `expected 1 request for one chunk, got ${requests.length}`);
      const expected = ['EnergyListed', 'EnergyListedWithExpiry', 'EnergyPurchased', 'ListingCancelled', 'ListingExpired']
        .map((name) => iface.getEvent(name).topicHash)
        .sort();
      assert.deepEqual([...topicsOf(requests[0])].sort(), expected);
    },
  });
});

test('logs from the combined request are indexed under the right event type', async () => {
  sync._testing.resetAdaptiveChunkCap();
  const logs = [
    makeLog('EnergyListed', [7, SELLER, 5, ethers.parseEther('0.5')], 995, 1),
    makeLog('EnergyPurchased', [7, BUYER, SELLER, 5, ethers.parseEther('0.5')], 997, 2),
    makeLog('ListingCancelled', [8, SELLER], 999, 3),
  ];
  await stubEnvironment({
    head: 1000,
    cursor: 900,
    getLogs: async () => logs,
    fn: async ({ trades, state }) => {
      const result = await sync.syncBlockchainTrades();

      assert.equal(result.skipped, undefined, `sync failed: ${result.message}`);
      assert.deepEqual(
        trades.map((t) => t.eventType).sort(),
        ['cancelled', 'listed', 'purchased'],
      );
      const purchased = trades.find((t) => t.eventType === 'purchased');
      assert.equal(purchased.buyer, BUYER);
      assert.equal(purchased.seller, SELLER);
      assert.equal(purchased.listingId, 7);
      assert.equal(state.lastSyncedBlock, 1000, 'cursor should advance to the chain head');
    },
  });
});

const runRangeLimitScenario = async ({ hinted, maxRequests }) => {
  sync._testing.resetAdaptiveChunkCap();
  const LIMIT = 10; // e.g. a free-tier RPC that rejects eth_getLogs ranges over 10 blocks
  const rangeError = () => {
    const err = new Error(
      hinted
        ? `Under the Free tier plan, you can make eth_getLogs requests with up to a ${LIMIT} block range.`
        : 'query exceeds max block range',
    );
    err.code = -32600;
    return err;
  };
  const getLogs = async (filter) => {
    if (rangeOf(filter) > LIMIT) throw rangeError();
    return [];
  };

  await stubEnvironment({
    head: 400,
    cursor: 0, // behind by 400 blocks
    getLogs,
    fn: async ({ requests: firstRun }) => {
      await sync.syncBlockchainTrades();
      assert.ok(sync._testing.getAdaptiveChunkCap() <= LIMIT, 'cap should settle at or below the provider limit');
      assert.ok(firstRun.length > 0);
    },
  });

  // Second catch-up: the cap is already known, so no request should be rejected.
  await stubEnvironment({
    head: 800,
    cursor: 400,
    getLogs,
    fn: async ({ requests }) => {
      const result = await sync.syncBlockchainTrades();
      assert.equal(result.skipped, undefined, `sync failed: ${result.message}`);
      const rejected = requests.filter((filter) => rangeOf(filter) > LIMIT);
      assert.equal(rejected.length, 0, `${rejected.length} requests exceeded the learned block-range limit`);
      assert.ok(requests.length <= maxRequests, `expected at most ${maxRequests} requests, got ${requests.length}`);
    },
  });

  sync._testing.resetAdaptiveChunkCap();
};

test('a stated provider block-range limit is learned once and used exactly', async () => {
  // 412 blocks (400 + re-org buffer) at 10 per request is ~42 requests.
  await runRangeLimitScenario({ hinted: true, maxRequests: 45 });
});

test('an unstated block-range limit is found by halving and then remembered', async () => {
  await runRangeLimitScenario({ hinted: false, maxRequests: 80 });
});
/* ------------------------------------------------------------------ */
/* Dedicated log-reading RPC (SYNC_RPC_URL) and limit message parsing  */
/* ------------------------------------------------------------------ */

test('block-range limits are read from the error messages of known providers', () => {
  const { extractRangeLimit } = sync._testing;
  assert.equal(
    extractRangeLimit(new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.')),
    10,
  );
  assert.equal(extractRangeLimit(new Error('exceed maximum block range: 50000')), 50000);
  assert.equal(extractRangeLimit(new Error('eth_getLogs is limited to 0 - 50 blocks range')), 50);
  assert.equal(extractRangeLimit(new Error('connection reset')), null);
});

test('SYNC_RPC_URL routes log reads to a separate provider; unset keeps the original', () => {
  const { forSyncReads } = sync._testing;
  const mainProvider = { marker: 'main' };
  const contract = new ethers.Contract(ADDRESS, ABI, { provider: mainProvider });
  const original = process.env.SYNC_RPC_URL;
  try {
    delete process.env.SYNC_RPC_URL;
    assert.equal(forSyncReads(contract), contract, 'unset must leave the contract untouched');

    process.env.SYNC_RPC_URL = 'https://sync-rpc.example.org/sepolia';
    const routed = forSyncReads(contract);
    assert.notEqual(routed, contract);
    assert.equal(routed.runner.provider._getConnection().url, 'https://sync-rpc.example.org/sepolia');
    assert.equal(contract.runner.provider, mainProvider, 'the original contract must not be modified');

    process.env.SYNC_RPC_URL = 'not-a-url';
    assert.equal(forSyncReads(contract), contract, 'an invalid URL is ignored');
  } finally {
    if (original === undefined) delete process.env.SYNC_RPC_URL;
    else process.env.SYNC_RPC_URL = original;
  }
});

test('a 125,000-block gap is cleared in a handful of requests on a provider allowing 50,000 blocks', async () => {
  sync._testing.resetAdaptiveChunkCap();
  const LIMIT = 50000;
  await stubEnvironment({
    head: 12_025_568,
    cursor: 11_900_366, // the real gap seen on the live site
    chunkSize: 5000,
    getLogs: async (filter) => {
      if (rangeOf(filter) > LIMIT) throw new Error('exceed maximum block range: 50000');
      return [];
    },
    fn: async ({ requests, state }) => {
      const result = await sync.syncBlockchainTrades();
      assert.equal(result.skipped, undefined, `sync failed: ${result.message}`);
      assert.equal(state.lastSyncedBlock, 12_025_568, 'cursor should reach the chain head');
      assert.ok(requests.length <= 30, `expected at most 30 requests, got ${requests.length}`);
    },
  });
  sync._testing.resetAdaptiveChunkCap();
});