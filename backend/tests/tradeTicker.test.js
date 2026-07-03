const { test, before, after } = require('node:test');
const assert = require('node:assert');

const {
  shapeTradeTickerItem,
  anonymizeWallet,
} = require('../services/tradeHistoryService');
const { SOCKET_EVENTS } = require('../socket/events');

const addr = (c) => '0x' + c.repeat(40);
const SELLER = addr('a');
const BUYER = addr('b');
const TX = '0x' + '1'.repeat(64);

// ---------------------------------------------------------------------------
// 1. shapeTradeTickerItem — the core sanitization/anonymization boundary.
//    This is the security-critical pure function: everything the ticker emits
//    (socket + REST seed) is normalized here, so it must reject junk and never
//    leak full wallet addresses.
// ---------------------------------------------------------------------------

test('shapeTradeTickerItem returns null for non-object input', () => {
  assert.strictEqual(shapeTradeTickerItem(null), null);
  assert.strictEqual(shapeTradeTickerItem(undefined), null);
  assert.strictEqual(shapeTradeTickerItem('trade'), null);
  assert.strictEqual(shapeTradeTickerItem(123), null);
});

test('shapeTradeTickerItem anonymizes seller and buyer (no full PII in global feed)', () => {
  const item = shapeTradeTickerItem({
    txHash: TX, logIndex: 3, listingId: 9,
    seller: SELLER, buyer: BUYER, energyAmount: 12, price: '6.5',
    blockTimestamp: new Date('2024-02-01T00:00:00Z'),
  });
  assert.strictEqual(item.seller, anonymizeWallet(SELLER));
  assert.strictEqual(item.buyer, anonymizeWallet(BUYER));
  assert.ok(item.seller.length < SELLER.length, 'seller must be truncated, not the full address');
  assert.ok(item.seller.startsWith('0x'));
  assert.ok(item.seller.includes('…'));
});

test('shapeTradeTickerItem builds a stable txHash:logIndex id for dedup', () => {
  const item = shapeTradeTickerItem({
    txHash: TX, logIndex: 7, seller: SELLER, buyer: BUYER,
    energyAmount: 1, price: '1',
  });
  assert.strictEqual(item.id, `${TX}:7`);
});

test('shapeTradeTickerItem falls back to a live composite id when txHash/logIndex missing', () => {
  const item = shapeTradeTickerItem({
    listingId: 5, seller: SELLER, buyer: BUYER, energyAmount: 1, price: '1',
    blockTimestamp: '2024-01-01T00:00:00Z',
  });
  assert.ok(item.id.startsWith('live:5:'), `got ${item.id}`);
  assert.ok(!item.id.includes(TX));
});

test('shapeTradeTickerItem coerces numeric fields and computes pricePerKwh', () => {
  const item = shapeTradeTickerItem({
    txHash: TX, logIndex: 1, seller: SELLER, buyer: BUYER,
    energyAmount: '50', price: '12.5', blockTimestamp: '2024-01-01T00:00:00Z',
  });
  assert.strictEqual(item.kwh, 50);
  assert.strictEqual(item.price, '12.5');
  assert.strictEqual(item.pricePerKwh, 0.25);
});

test('shapeTradeTickerItem guards divide-by-zero on zero-energy trades', () => {
  const item = shapeTradeTickerItem({
    txHash: TX, logIndex: 1, seller: SELLER, buyer: BUYER,
    energyAmount: 0, price: '0',
  });
  assert.strictEqual(item.kwh, 0);
  assert.strictEqual(item.pricePerKwh, 0);
});

test('shapeTradeTickerItem repairs malformed/missing numeric fields', () => {
  const item = shapeTradeTickerItem({
    txHash: TX, logIndex: 1, seller: SELLER, buyer: BUYER,
    energyAmount: 'NaN-ish', price: { not: 'a string' },
  });
  assert.strictEqual(item.kwh, 0);
  assert.strictEqual(item.price, '0');
  assert.strictEqual(item.pricePerKwh, 0);
});

test('shapeTradeTickerItem maps invalid listingId to null', () => {
  const ok = shapeTradeTickerItem({ txHash: TX, logIndex: 1, listingId: 3, seller: SELLER, buyer: BUYER, energyAmount: 1, price: '1' });
  assert.strictEqual(ok.listingId, 3);
  const bad = shapeTradeTickerItem({ txHash: TX, logIndex: 2, listingId: 'abc', seller: SELLER, buyer: BUYER, energyAmount: 1, price: '1' });
  assert.strictEqual(bad.listingId, null);
});

test('shapeTradeTickerItem normalizes ts from Date and falls back to now for junk', () => {
  const fromObj = shapeTradeTickerItem({ txHash: TX, logIndex: 1, seller: SELLER, buyer: BUYER, energyAmount: 1, price: '1', blockTimestamp: new Date('2024-03-04T05:06:07Z') });
  assert.strictEqual(fromObj.ts, '2024-03-04T05:06:07.000Z');
  const fromJunk = shapeTradeTickerItem({ txHash: TX, logIndex: 2, seller: SELLER, buyer: BUYER, energyAmount: 1, price: '1', blockTimestamp: 'not-a-date' });
  assert.ok(Number.isFinite(new Date(fromJunk.ts).getTime()));
});

test('shapeTradeTickerItem nulls out invalid wallet addresses', () => {
  const item = shapeTradeTickerItem({
    txHash: TX, logIndex: 1, seller: '0xdead', buyer: null,
    energyAmount: 1, price: '1',
  });
  assert.strictEqual(item.seller, null);
  assert.strictEqual(item.buyer, null);
});

test('socket event name is the canonical tradeExecuted string', () => {
  assert.strictEqual(SOCKET_EVENTS.SERVER.TRADE_EXECUTED, 'tradeExecuted');
  assert.strictEqual(SOCKET_EVENTS.SERVER.SETTLEMENT_VERIFIED, 'settlementVerified');
  assert.strictEqual(SOCKET_EVENTS.SERVER.SETTLEMENT_MISMATCH, 'settlementMismatch');
});

// ---------------------------------------------------------------------------
// 2. emitTradeExecuted — verify it routes a SANITIZED item to the
//    `authenticated` room under TRADE_EXECUTED, and drops junk. analytics is
//    stubbed so the service loads without its full dependency tree.
// ---------------------------------------------------------------------------

const originals = {};
let emitTradeExecuted;
let setIo;
const calls = [];
const fakeIo = {
  to(room) {
    return {
      emit(event, payload) {
        calls.push({ room, event, payload });
      },
    };
  },
};

before(() => {
  const analyticsAbs = require.resolve('../services/analytics');
  if (require.cache[analyticsAbs]) originals[analyticsAbs] = require.cache[analyticsAbs];
  require.cache[analyticsAbs] = {
    id: analyticsAbs, filename: analyticsAbs, loaded: true, exports: {}, paths: [], children: [],
  };

  const svcPath = require.resolve('../services/socketBroadcastService');
  delete require.cache[svcPath];
  ({ emitTradeExecuted, setIo } = require('../services/socketBroadcastService'));
  setIo(fakeIo);
});

after(() => {
  for (const abs of Object.keys(originals)) require.cache[abs] = originals[abs];
  const analyticsAbs = require.resolve('../services/analytics');
  if (!originals[analyticsAbs]) delete require.cache[analyticsAbs];
  delete require.cache[require.resolve('../services/socketBroadcastService')];
});

test('emitTradeExecuted broadcasts an anonymized item to the authenticated room', () => {
  calls.length = 0;
  emitTradeExecuted({
    txHash: TX, logIndex: 4, listingId: 2,
    seller: SELLER, buyer: BUYER, energyAmount: 7, price: '3.5',
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].room, 'authenticated');
  assert.strictEqual(calls[0].event, SOCKET_EVENTS.SERVER.TRADE_EXECUTED);
  assert.strictEqual(calls[0].payload.id, `${TX}:4`);
  assert.strictEqual(calls[0].payload.seller, anonymizeWallet(SELLER));
  assert.strictEqual(calls[0].payload.kwh, 7);
});

test('emitTradeExecuted drops malformed input (no broadcast)', () => {
  calls.length = 0;
  emitTradeExecuted(null);
  emitTradeExecuted(undefined);
  emitTradeExecuted('nope');
  emitTradeExecuted({ noId: true });
  assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------------------
// 3. GET /trades/recent controller — input-validation guardrails + shaping.
//    Mocks the trade history service so we assert param clamping and that the
//    response only ever carries anonymized items.
// ---------------------------------------------------------------------------

const captured = { opts: null };
const rawTrades = [
  { txHash: TX, logIndex: 0, listingId: 1, seller: SELLER, buyer: BUYER, energyAmount: 10, price: '5', blockTimestamp: new Date('2024-01-01T00:00:00Z') },
  null, // must be filtered out by the controller
];

const serviceMock = {
  getRecentTrades: async (opts) => { captured.opts = opts; return rawTrades; },
  shapeTradeTickerItem,
  TRADE_EVENT_TYPES: ['listed', 'purchased', 'cancelled', 'expired'],
};

const ctrlOriginals = {};
let getRecent;

before(() => {
  const svcAbs = require.resolve('../services/tradeHistoryService');
  const bcAbs = require.resolve('../services/blockchainSyncService');
  [svcAbs, bcAbs].forEach((abs) => {
    if (require.cache[abs]) ctrlOriginals[abs] = require.cache[abs];
  });
  require.cache[svcAbs] = { id: svcAbs, filename: svcAbs, loaded: true, exports: serviceMock, paths: [], children: [] };
  require.cache[bcAbs] = { id: bcAbs, filename: bcAbs, loaded: true, exports: {}, paths: [], children: [] };
  const ctrlPath = require.resolve('../controllers/tradesController');
  delete require.cache[ctrlPath];
  ({ getRecent } = require('../controllers/tradesController'));
});

after(() => {
  for (const abs of Object.keys(ctrlOriginals)) require.cache[abs] = ctrlOriginals[abs];
  const svcAbs = require.resolve('../services/tradeHistoryService');
  const bcAbs = require.resolve('../services/blockchainSyncService');
  if (!ctrlOriginals[svcAbs]) delete require.cache[svcAbs];
  if (!ctrlOriginals[bcAbs]) delete require.cache[bcAbs];
  delete require.cache[require.resolve('../controllers/tradesController')];
});

const run = async (query) => {
  const res = {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await getRecent({ query }, res);
  return res;
};

test('getRecent clamps limit to [1,100] with default 50', async () => {
  await run({ limit: '9999' });
  assert.strictEqual(captured.opts.limit, 100);
  await run({ limit: '0' });
  assert.strictEqual(captured.opts.limit, 50);
  await run({ limit: 'abc' });
  assert.strictEqual(captured.opts.limit, 50);
  await run({});
  assert.strictEqual(captured.opts.limit, 50);
  await run({ limit: '5' });
  assert.strictEqual(captured.opts.limit, 5);
});

test('getRecent defaults invalid eventType to purchased and accepts valid ones', async () => {
  await run({ eventType: 'bogus' });
  assert.strictEqual(captured.opts.eventType, 'purchased');
  await run({ eventType: 'listed' });
  assert.strictEqual(captured.opts.eventType, 'listed');
});

test('getRecent bounds sinceDays to (0, 365] else null', async () => {
  await run({ sinceDays: '-3' });
  assert.strictEqual(captured.opts.sinceDays, null);
  await run({ sinceDays: '0' });
  assert.strictEqual(captured.opts.sinceDays, null);
  await run({ sinceDays: '99999' });
  assert.strictEqual(captured.opts.sinceDays, 365);
  await run({ sinceDays: '12' });
  assert.strictEqual(captured.opts.sinceDays, 12);
});

test('getRecent returns anonymized items and filters junk', async () => {
  const res = await run({ limit: '5' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.length, 1);
  const item = res.body.data[0];
  assert.strictEqual(item.seller, anonymizeWallet(SELLER));
  assert.strictEqual(item.kwh, 10);
  assert.strictEqual(item.id, `${TX}:0`);
});
