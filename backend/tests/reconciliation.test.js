const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.JWT_ACCESS_SECRET = 'test';
process.env.JWT_REFRESH_SECRET = 'test';
process.env.SETTLEMENT_TOLERANCE_PCT = '5';
process.env.SETTLEMENT_AUTOFLAG_SCORE = '0.8';

// ---------------------------------------------------------------------------
// Mutable mock state — read at call time so each test flips behaviour without
// re-requiring the service. require.cache is snapshotted/restored so other test
// files are unaffected (same isolation strategy as tests/anomaly.test.js).
// ---------------------------------------------------------------------------
const state = {
  readings: [],
  anomalyScore: null,
  listingCreatedAt: 1000, // unix seconds
  settlement: null,
};

const calls = { emit: [], audit: [], update: [] };

// Chainable query builder mock: EnergyReading.find(...).sort().select().lean()
const chainable = (resolver) => {
  const chain = {
    sort() { return chain; },
    select() { return chain; },
    limit() { return chain; },
    lean() { return Promise.resolve(resolver()); },
  };
  return chain;
};

const blockchainServiceMock = {
  getEnergyTradingContractReadOnly: () => ({
    listings: async () => ({ createdAt: state.listingCreatedAt, seller: '0x' + '1'.repeat(40) }),
  }),
};

const settlementMock = {
  findById: async (id) => ({ ...state.settlement, _id: id }),
  findOne: async () => null,
  findOneAndUpdate: (filter, update) => {
    calls.update.push({ filter, update });
    const merged = { ...state.settlement, ...update.$set, _id: 'settlement-1' };
    return { lean: async () => merged };
  },
  countDocuments: async () => 0,
  find: () => chainable(() => []),
  updateOne: async () => ({ upsertedId: 'x' }),
};

const tradeMock = {
  findById: async () => ({ blockTimestamp: new Date(1000 * (state.listingCreatedAt + 3600)) }),
  findOne: () => chainable(() => null),
  find: () => chainable(() => []),
};

const userMock = { findOne: () => chainable(() => ({ _id: 'user-1' })) };
const nodeMock = { find: () => chainable(() => [{ _id: 'node-1' }]) };
const anomalyMock = {
  find: () => chainable(() =>
    state.anomalyScore != null ? [{ score: state.anomalyScore }] : [],
  ),
};

const readingMock = { find: () => chainable(() => state.readings) };
const socketMock = { emitBlockchainEvent: (p) => { calls.emit.push(p); } };
const auditMock = { log: async (entry) => { calls.audit.push(entry); } };
const loggerMock = { logger: { info() {}, warn() {} }, logBackgroundError() {} };

const mockExports = {
  '../services/blockchainService': blockchainServiceMock,
  '../models/Settlement': settlementMock,
  '../models/Trade': tradeMock,
  '../models/EnergyNode': nodeMock,
  '../models/EnergyReading': readingMock,
  '../models/User': userMock,
  '../models/AnomalyEvent': anomalyMock,
  '../services/socketBroadcastService': socketMock,
  '../services/auditService': auditMock,
  '../utils/logger': loggerMock,
};

const mockPaths = Object.keys(mockExports);
const originals = {};
let reconcileSettlement;

before(() => {
  for (const p of mockPaths) {
    const abs = require.resolve(p);
    if (require.cache[abs]) originals[abs] = require.cache[abs];
    require.cache[abs] = {
      id: abs, filename: abs, loaded: true, exports: mockExports[p], paths: [], children: [],
    };
  }
  const svcPath = require.resolve('../services/reconciliationService');
  delete require.cache[svcPath];
  ({ reconcileSettlement } = require('../services/reconciliationService'));
});

after(() => {
  for (const abs of Object.keys(originals)) require.cache[abs] = originals[abs];
  for (const p of mockPaths) {
    const abs = require.resolve(p);
    if (!originals[abs]) delete require.cache[abs];
  }
  delete require.cache[require.resolve('../services/reconciliationService')];
});

const MS = 3600 * 1000;
const baseSettlement = () => ({
  chainId: 31337,
  contractAddress: '0x' + '0'.repeat(40),
  txHash: '0x' + 'a'.repeat(64),
  logIndex: 0,
  listingId: 1,
  tradeRef: null,
  seller: '0x' + '1'.repeat(40),
  buyer: '0x' + '2'.repeat(40),
  verificationStatus: 'pending',
  onChainEnergy: 100,
  onChainPrice: '1.0',
  mismatchFlags: [],
  evidence: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});

beforeEach(() => {
  state.readings = [];
  state.anomalyScore = null;
  state.listingCreatedAt = 1000;
  state.settlement = baseSettlement();
  calls.emit = [];
  calls.audit = [];
  calls.update = [];
});

test('flags READING_GAP when no meter telemetry exists for the window', async () => {
  state.readings = [];
  const result = await reconcileSettlement(state.settlement);
  assert.ok(result.mismatchFlags.includes('READING_GAP'));
  assert.strictEqual(result.verificationStatus, 'mismatch');
  assert.strictEqual(result.offChainEnergy, 0);
});

test('flags UNDER_DELIVERY when measured generation is far below on-chain amount', async () => {
  // 1 hour window, ~5kW avg → 5kWh vs 100 on-chain → -95% (well beyond 5% tol).
  state.readings = [
    { energyGenerated: 5, timestamp: new Date(1000 * 1000), unit: 'kW' },
    { energyGenerated: 5, timestamp: new Date(1000 * 1000 + MS), unit: 'kW' },
  ];
  const result = await reconcileSettlement(state.settlement);
  assert.ok(result.mismatchFlags.includes('UNDER_DELIVERY'));
  assert.strictEqual(result.verificationStatus, 'mismatch');
  assert.ok(result.deltaPct < -5);
});

test('flags OVER_DELIVERY when measured generation exceeds on-chain amount', async () => {
  // 200kWh vs 100 on-chain → +100%.
  state.readings = [
    { energyGenerated: 200, timestamp: new Date(1000 * 1000), unit: 'kW' },
    { energyGenerated: 200, timestamp: new Date(1000 * 1000 + MS), unit: 'kW' },
  ];
  const result = await reconcileSettlement(state.settlement);
  assert.ok(result.mismatchFlags.includes('OVER_DELIVERY'));
  assert.ok(result.deltaPct > 5);
});

test('keeps verified status when delivery is within tolerance', async () => {
  // ~100kWh vs 100 on-chain.
  state.readings = [
    { energyGenerated: 100, timestamp: new Date(1000 * 1000), unit: 'kW' },
    { energyGenerated: 100, timestamp: new Date(1000 * 1000 + MS), unit: 'kW' },
  ];
  const result = await reconcileSettlement(state.settlement);
  assert.strictEqual(result.mismatchFlags.length, 0);
  assert.strictEqual(result.verificationStatus, 'pending');
  assert.ok(Math.abs(result.deltaPct) <= 5);
});

test('auto-escalates to disputed when mismatch AND anomaly score high', async () => {
  state.readings = [
    { energyGenerated: 5, timestamp: new Date(1000 * 1000), unit: 'kW' },
    { energyGenerated: 5, timestamp: new Date(1000 * 1000 + MS), unit: 'kW' },
  ];
  state.anomalyScore = 0.9;
  const result = await reconcileSettlement(state.settlement);
  assert.strictEqual(result.verificationStatus, 'disputed');
  assert.strictEqual(result.autoFlagged, true);
  assert.strictEqual(result.anomalyScore, 0.9);
});

test('does NOT auto-escalate when anomaly score is below threshold', async () => {
  state.readings = [
    { energyGenerated: 5, timestamp: new Date(1000 * 1000), unit: 'kW' },
    { energyGenerated: 5, timestamp: new Date(1000 * 1000 + MS), unit: 'kW' },
  ];
  state.anomalyScore = 0.3;
  const result = await reconcileSettlement(state.settlement);
  assert.strictEqual(result.verificationStatus, 'mismatch');
  assert.ok(!result.autoFlagged);
});

test('emits a settlementMismatch socket event on a flagged reconciliation', async () => {
  state.readings = [];
  await reconcileSettlement(state.settlement);
  assert.ok(calls.emit.some((p) => p.eventType === 'settlementMismatch'));
  assert.ok(calls.audit.length > 0);
});
