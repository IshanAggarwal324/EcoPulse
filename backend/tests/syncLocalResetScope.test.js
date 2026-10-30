const { test } = require('node:test');
const assert = require('node:assert/strict');

const Trade = require('../models/Trade');
const SyncState = require('../models/SyncState');
const BlockchainService = require('../services/blockchainService');
const sync = require('../services/blockchainSyncService');

/*
 * A dev backend (Hardhat, chain 31337) and a deployed backend (Sepolia) may be
 * pointed at the same MongoDB. When the local chain restarts, the sync wipes the
 * local trade history. That wipe must never touch trades from other chains.
 */

const withStubs = async (fn) => {
  const originals = {
    contractFactory: BlockchainService.getEnergyTradingContractReadOnly,
    findOneAndUpdate: SyncState.findOneAndUpdate,
    deleteMany: Trade.deleteMany,
    address: process.env.ENERGY_TRADING_ADDRESS,
  };

  const deletes = [];
  const state = {
    key: 'energy_trading',
    chainId: 31337,
    contractAddress: '0x' + '1'.repeat(40),
    lastSyncedBlock: 500, // previous run on the (now restarted) local chain
    save: async () => state,
  };

  process.env.ENERGY_TRADING_ADDRESS = state.contractAddress;

  const provider = {
    getNetwork: async () => ({ chainId: 31337n }),
    getBlockNumber: async () => 5, // chain restarted: head is behind the saved cursor
    getCode: async () => '0x6001',
  };
  const filters = new Proxy({}, { get: () => () => ({ getTopicFilter: async () => ['0x' + '1'.repeat(64)] }) });
  BlockchainService.getEnergyTradingContractReadOnly = () => ({
    runner: { provider },
    filters,
    queryFilter: async () => [],
  });
  SyncState.findOneAndUpdate = async () => state;
  Trade.deleteMany = async (filter) => {
    deletes.push(filter);
    return { deletedCount: 0 };
  };

  const origLog = console.log;
  console.log = () => {};
  try {
    await fn({ deletes });
  } finally {
    console.log = origLog;
    BlockchainService.getEnergyTradingContractReadOnly = originals.contractFactory;
    SyncState.findOneAndUpdate = originals.findOneAndUpdate;
    Trade.deleteMany = originals.deleteMany;
    if (originals.address === undefined) delete process.env.ENERGY_TRADING_ADDRESS;
    else process.env.ENERGY_TRADING_ADDRESS = originals.address;
  }
};

test('local chain reset only deletes trades indexed from the local chain', async () => {
  await withStubs(async ({ deletes }) => {
    await sync.syncBlockchainTrades();

    assert.equal(deletes.length, 1, 'a local reset should clear local trades once');
    assert.deepEqual(
      deletes[0],
      { chainId: 31337 },
      `reset must be scoped to the local chain, got filter ${JSON.stringify(deletes[0])}`,
    );
  });
});
