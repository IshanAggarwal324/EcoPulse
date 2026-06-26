const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildTradeQuery,
  anonymizeWallet,
  TRADE_EVENT_TYPES,
} = require('../services/tradeHistoryService');
const {
  aggregateLegs,
  buildLeg,
  summarizeLegs,
  DEFAULT_WINDOW_DAYS,
} = require('../services/tradeAggregationService');
const {
  resolveMarketplaceTradeScope,
  anonymizeTradeForTape,
  parseWallet,
  parseListingId,
} = require('../controllers/marketplaceTradeHistoryController');

const addr = (c) => '0x' + c.repeat(40);
const SELLER = addr('a');
const BUYER1 = addr('b');
const BUYER2 = addr('c');
const TX = '0x' + '1'.repeat(64);

const assertThrowsStatus = (fn, statusCode, message) => {
  try {
    fn();
    assert.fail(`Expected throw with statusCode ${statusCode}`);
  } catch (err) {
    assert.strictEqual(err.statusCode, statusCode, message || `status ${statusCode}`);
  }
};

test('TRADE_EVENT_TYPES includes expired', () => {
  assert.ok(TRADE_EVENT_TYPES.includes('expired'));
});

test('anonymizeWallet truncates valid addresses and rejects invalid input', () => {
  assert.strictEqual(anonymizeWallet(SELLER), '0xaaaa…aaaa');
  assert.strictEqual(anonymizeWallet(BUYER1), '0xbbbb…bbbb');
  assert.strictEqual(anonymizeWallet(null), null);
  assert.strictEqual(anonymizeWallet(undefined), null);
  assert.strictEqual(anonymizeWallet('0xdead'), null);
  assert.strictEqual(anonymizeWallet(123), null);
  assert.strictEqual(anonymizeWallet(SELLER.toUpperCase()), '0xaaaa…aaaa');
});

test('buildTradeQuery accepts expired eventType', () => {
  assert.deepStrictEqual(buildTradeQuery({ eventType: 'expired' }), { eventType: 'expired' });
});

test('buildTradeQuery silently drops an invalid eventType (no enum match)', () => {
  assert.deepStrictEqual(buildTradeQuery({ eventType: 'bogus' }), {});
});

test('buildTradeQuery supports seller and buyer marketplace filters', () => {
  assert.deepStrictEqual(buildTradeQuery({ seller: SELLER }), { seller: SELLER });
  assert.deepStrictEqual(buildTradeQuery({ buyer: BUYER1 }), { buyer: BUYER1 });
  const both = buildTradeQuery({ seller: SELLER, buyer: BUYER1 });
  assert.deepStrictEqual(both, { $and: [{ seller: SELLER }, { buyer: BUYER1 }] });
});

test('buildTradeQuery scopes wallet to seller OR buyer', () => {
  const q = buildTradeQuery({ wallet: SELLER });
  assert.deepStrictEqual(q, { $or: [{ seller: SELLER }, { buyer: SELLER }] });
});

test('buildTradeQuery casts listingId to Number and bounds by price expr', () => {
  const q = buildTradeQuery({ listingId: '7', minPrice: '1', maxPrice: '10' });
  assert.ok(Array.isArray(q.$and));
  assert.deepStrictEqual(q.$and[0], { listingId: 7 });
  assert.deepStrictEqual(q.$and[1].$expr.$gte, [{ $toDouble: '$price' }, 1]);
  assert.deepStrictEqual(q.$and[2].$expr.$lte, [{ $toDouble: '$price' }, 10]);
});

test('buildTradeQuery applies sinceDays as a blockTimestamp bound', () => {
  const q = buildTradeQuery({ sinceDays: '7' });
  assert.ok(q.blockTimestamp && q.blockTimestamp.$gte instanceof Date);
  const expected = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  assert.ok(Math.abs(q.blockTimestamp.$gte.getTime() - expected.getTime()) < 1000);
});

test('buildLeg groups partial fills with volume-weighted avg price and fill rate', () => {
  const fills = [
    { listingId: 1, energyAmount: 10, price: '5', buyer: BUYER1, seller: SELLER, blockTimestamp: '2024-01-01T00:00:00Z' },
    { listingId: 1, energyAmount: 30, price: '12', buyer: BUYER2, seller: SELLER, blockTimestamp: '2024-01-02T00:00:00Z' },
  ];
  const leg = buildLeg(1, fills, { listingId: 1, energyAmount: 50 });

  assert.strictEqual(leg.listingId, 1);
  assert.strictEqual(leg.fillCount, 2);
  assert.strictEqual(leg.totalEnergy, 40);
  assert.strictEqual(leg.totalVolumeCc, 17);
  assert.strictEqual(leg.avgPrice, 17 / 40);
  assert.strictEqual(leg.minUnitPrice, 0.4);
  assert.strictEqual(leg.maxUnitPrice, 0.5);
  assert.strictEqual(leg.seller, SELLER);
  assert.strictEqual(leg.buyerCount, 2);
  assert.deepStrictEqual(leg.buyers.sort(), [BUYER1, BUYER2].sort());
  assert.strictEqual(leg.firstFillAt, '2024-01-01T00:00:00Z');
  assert.strictEqual(leg.lastFillAt, '2024-01-02T00:00:00Z');
  assert.strictEqual(leg.listedEnergy, 50);
  assert.strictEqual(leg.fillRate, 0.8);
});

test('buildLeg caps fillRate at 1.0 when energy exceeds listed amount', () => {
  const fills = [{ listingId: 2, energyAmount: 60, price: '10', buyer: BUYER1, seller: SELLER, blockTimestamp: '2024-01-01T00:00:00Z' }];
  const leg = buildLeg(2, fills, { listingId: 2, energyAmount: 50 });
  assert.strictEqual(leg.fillRate, 1);
});

test('buildLeg handles zero-energy fills without divide-by-zero', () => {
  const fills = [{ listingId: 3, energyAmount: 0, price: '5', buyer: BUYER1, seller: SELLER, blockTimestamp: '2024-01-01T00:00:00Z' }];
  const leg = buildLeg(3, fills, null);
  assert.strictEqual(leg.totalEnergy, 0);
  assert.strictEqual(leg.avgPrice, 0);
  assert.strictEqual(leg.minUnitPrice, null);
  assert.strictEqual(leg.maxUnitPrice, null);
  assert.strictEqual(leg.fillRate, null);
  assert.strictEqual(leg.listedEnergy, null);
});

test('aggregateLegs groups by listing and sorts by last fill desc', () => {
  const purchases = [
    { listingId: 1, energyAmount: 10, price: '5', buyer: BUYER1, seller: SELLER, blockTimestamp: '2024-01-01T00:00:00Z' },
    { listingId: 2, energyAmount: 20, price: '8', buyer: BUYER2, seller: SELLER, blockTimestamp: '2024-01-03T00:00:00Z' },
    { listingId: 1, energyAmount: 5, price: '2', buyer: BUYER1, seller: SELLER, blockTimestamp: '2024-01-05T00:00:00Z' },
  ];
  const legs = aggregateLegs(purchases, [
    { listingId: 1, energyAmount: 20 },
    { listingId: 2, energyAmount: 20 },
  ]);
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs[0].listingId, 1);
  assert.strictEqual(legs[1].listingId, 2);
  assert.strictEqual(legs[0].fillCount, 2);
  assert.strictEqual(legs[0].lastFillAt, '2024-01-05T00:00:00Z');
});

test('aggregateLegs ignores malformed listingIds', () => {
  const purchases = [
    { listingId: NaN, energyAmount: 10, price: '5', buyer: BUYER1, seller: SELLER, blockTimestamp: '2024-01-01T00:00:00Z' },
    { listingId: 5, energyAmount: 10, price: '5', buyer: BUYER1, seller: SELLER, blockTimestamp: '2024-01-01T00:00:00Z' },
  ];
  const legs = aggregateLegs(purchases, []);
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].listingId, 5);
});

test('aggregateLegs returns empty for no input', () => {
  assert.deepStrictEqual(aggregateLegs([], []), []);
  assert.deepStrictEqual(aggregateLegs(), []);
});

test('summarizeLegs aggregates totals and counts fully filled legs', () => {
  const legs = [
    { fillCount: 2, totalEnergy: 40, totalVolumeCc: 17, fillRate: 0.8 },
    { fillCount: 1, totalEnergy: 50, totalVolumeCc: 25, fillRate: 1 },
  ];
  const s = summarizeLegs(legs);
  assert.strictEqual(s.legCount, 2);
  assert.strictEqual(s.totalFills, 3);
  assert.strictEqual(s.totalEnergy, 90);
  assert.strictEqual(s.totalVolumeCc, 42);
  assert.strictEqual(s.avgPrice, 42 / 90);
  assert.strictEqual(s.fullyFilledCount, 1);
});

test('summarizeLegs guards against empty legs', () => {
  const s = summarizeLegs([]);
  assert.strictEqual(s.legCount, 0);
  assert.strictEqual(s.avgPrice, 0);
});

test('parseWallet accepts valid addresses and flags invalid ones as false', () => {
  assert.strictEqual(parseWallet(SELLER), SELLER);
  assert.strictEqual(parseWallet(''), null);
  assert.strictEqual(parseWallet(undefined), null);
  assert.strictEqual(parseWallet('0xdead'), false);
});

test('parseListingId accepts non-negative integers and flags invalid ones as false', () => {
  assert.strictEqual(parseListingId('7'), 7);
  assert.strictEqual(parseListingId(0), 0);
  assert.strictEqual(parseListingId(''), null);
  assert.strictEqual(parseListingId('-1'), false);
  assert.strictEqual(parseListingId('abc'), false);
  assert.strictEqual(parseListingId('1.5'), false);
});

test('resolveMarketplaceTradeScope allows admin to query unscoped', () => {
  const req = { user: { role: 'admin', walletAddress: SELLER }, query: {} };
  assert.deepStrictEqual(resolveMarketplaceTradeScope(req), {
    wallet: null,
    seller: null,
    buyer: null,
    listingId: null,
  });
});

test('resolveMarketplaceTradeScope rejects unscoped queries from regular users', () => {
  const req = { user: { role: 'user', walletAddress: SELLER }, query: {} };
  assertThrowsStatus(() => resolveMarketplaceTradeScope(req), 403);
});

test('resolveMarketplaceTradeScope allows regular users to query their own wallet', () => {
  const req = { user: { role: 'user', walletAddress: SELLER }, query: { wallet: SELLER } };
  const scope = resolveMarketplaceTradeScope(req);
  assert.strictEqual(scope.wallet, SELLER);
});

test('resolveMarketplaceTradeScope blocks regular users from querying other wallets (IDOR)', () => {
  const req = { user: { role: 'user', walletAddress: SELLER }, query: { wallet: BUYER1 } };
  assertThrowsStatus(() => resolveMarketplaceTradeScope(req), 403);
});

test('resolveMarketplaceTradeScope blocks regular user filtering by another seller', () => {
  const req = { user: { role: 'user', walletAddress: SELLER }, query: { seller: BUYER1 } };
  assertThrowsStatus(() => resolveMarketplaceTradeScope(req), 403);
});

test('resolveMarketplaceTradeScope allows public per-listing history for any user', () => {
  const req = { user: { role: 'user', walletAddress: SELLER }, query: { listingId: '42' } };
  const scope = resolveMarketplaceTradeScope(req);
  assert.strictEqual(scope.listingId, 42);
  assert.strictEqual(scope.wallet, null);
});

test('resolveMarketplaceTradeScope rejects invalid wallet with 400', () => {
  const req = { user: { role: 'user', walletAddress: SELLER }, query: { wallet: '0xdead' } };
  assertThrowsStatus(() => resolveMarketplaceTradeScope(req), 400);
});

test('resolveMarketplaceTradeScope rejects invalid listingId with 400', () => {
  const req = { user: { role: 'user', walletAddress: SELLER }, query: { listingId: 'abc' } };
  assertThrowsStatus(() => resolveMarketplaceTradeScope(req), 400);
});

test('resolveMarketplaceTradeScope blocks user with no registered wallet confirming ownership of another', () => {
  const req = { user: { role: 'user' }, query: { wallet: SELLER } };
  assertThrowsStatus(() => resolveMarketplaceTradeScope(req), 403);
});

test('anonymizeTradeForTape anonymizes counterparties and strips internal fields', () => {
  const trade = {
    _id: 'internal-id',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    listingId: 9,
    eventType: 'purchased',
    seller: SELLER,
    buyer: BUYER1,
    energyAmount: 12,
    price: '6.5',
    blockTimestamp: '2024-02-01T00:00:00Z',
    txHash: TX,
  };
  const tape = anonymizeTradeForTape(trade);
  assert.strictEqual(tape.seller, '0xaaaa…aaaa');
  assert.strictEqual(tape.buyer, '0xbbbb…bbbb');
  assert.strictEqual(tape.listingId, 9);
  assert.strictEqual(tape.eventType, 'purchased');
  assert.strictEqual(tape.energyAmount, 12);
  assert.strictEqual(tape.price, '6.5');
  assert.strictEqual(tape.txHash, TX);
  assert.strictEqual(tape.blockTimestamp, '2024-02-01T00:00:00Z');
  assert.strictEqual(tape._id, undefined);
  assert.strictEqual(tape.createdAt, undefined);
});

test('aggregation window defaults to a bounded lookback', () => {
  assert.ok(DEFAULT_WINDOW_DAYS > 0 && DEFAULT_WINDOW_DAYS <= 365);
});
