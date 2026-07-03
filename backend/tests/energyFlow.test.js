const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseWindow,
  normalizeWallet,
  resolveFlowScope,
  buildFlowGraph,
  keyPair,
  round,
  shortAddr,
  ALLOWED_WINDOWS,
  DEFAULT_WINDOW,
} = require('../services/analytics/flowService');

const addr = (c) => '0x' + c.repeat(40);
const SELLER = addr('a'); // 0xaaa...
const BUYER = addr('b'); // 0xbbb...
const OTHER = addr('c');

const assertThrows = (fn, statusCode, label) => {
  try {
    fn();
    assert.fail(`Expected throw${label ? ` (${label})` : ''}`);
  } catch (err) {
    if (statusCode !== undefined) assert.strictEqual(err.statusCode, statusCode);
    assert.ok(err.message);
  }
};

// ---- parseWindow -----------------------------------------------------------
test('parseWindow returns default when empty', () => {
  assert.strictEqual(parseWindow(''), DEFAULT_WINDOW);
  assert.strictEqual(parseWindow(undefined), DEFAULT_WINDOW);
  assert.strictEqual(parseWindow(null), DEFAULT_WINDOW);
  assert.strictEqual(parseWindow('   '), DEFAULT_WINDOW);
});

test('parseWindow accepts allowed windows', () => {
  for (const w of ALLOWED_WINDOWS) assert.strictEqual(parseWindow(w), w);
});

test('parseWindow rejects unknown values with 400', () => {
  assertThrows(() => parseWindow('1h'), 400);
  assertThrows(() => parseWindow('foo'), 400);
  assertThrows(() => parseWindow('999d'), 400);
});

// ---- normalizeWallet -------------------------------------------------------
test('normalizeWallet lowercases valid addresses', () => {
  assert.strictEqual(normalizeWallet(SELLER.toUpperCase()), SELLER);
  assert.strictEqual(normalizeWallet(` ${SELLER} `), SELLER);
});

test('normalizeWallet returns null for empty input', () => {
  assert.strictEqual(normalizeWallet(''), null);
  assert.strictEqual(normalizeWallet(null), null);
  assert.strictEqual(normalizeWallet(undefined), null);
});

test('normalizeWallet rejects malformed addresses with 400', () => {
  assertThrows(() => normalizeWallet('0xdead'), 400);
  assertThrows(() => normalizeWallet('0xZZZZ' + '0'.repeat(35)), 400);
  assertThrows(() => normalizeWallet({ foo: 1 }), 400);
});

// ---- resolveFlowScope ------------------------------------------------------
test('resolveFlowScope: privileged sees global', () => {
  const s = resolveFlowScope({ role: 'admin', _id: 'u1' }, {});
  assert.strictEqual(s.scope, 'global');
  assert.strictEqual(s.wallet, null);
  assert.strictEqual(s.privileged, true);
});

test('resolveFlowScope: privileged may request a wallet', () => {
  const s = resolveFlowScope({ role: 'admin', _id: 'u1' }, { wallet: SELLER });
  assert.strictEqual(s.scope, 'global');
  assert.strictEqual(s.wallet, SELLER);
});

test('resolveFlowScope: non-privileged locked to own wallet', () => {
  const s = resolveFlowScope({ role: 'user', _id: 'u1', walletAddress: BUYER }, {});
  assert.strictEqual(s.scope, 'wallet');
  assert.strictEqual(s.wallet, BUYER);
  assert.strictEqual(s.privileged, false);
});

test('resolveFlowScope: non-privileged without wallet throws 400', () => {
  assertThrows(
    () => resolveFlowScope({ role: 'user', _id: 'u1', walletAddress: null }, {}),
    400,
    'no wallet',
  );
});

test('resolveFlowScope: non-privileged requesting another wallet throws 403', () => {
  assertThrows(
    () => resolveFlowScope({ role: 'user', _id: 'u1', walletAddress: BUYER }, { wallet: SELLER }),
    403,
    'cross wallet',
  );
});

test('resolveFlowScope: non-privileged requesting own wallet is allowed', () => {
  const s = resolveFlowScope({ role: 'user', _id: 'u1', walletAddress: BUYER }, { wallet: BUYER.toUpperCase() });
  assert.strictEqual(s.wallet, BUYER);
});

test('resolveFlowScope: moderator is privileged', () => {
  const s = resolveFlowScope({ role: 'moderator', _id: 'u1' }, {});
  assert.strictEqual(s.privileged, true);
});

// ---- keyPair / round / shortAddr ------------------------------------------
test('keyPair lowercases and joins', () => {
  assert.strictEqual(keyPair(SELLER.toUpperCase(), BUYER.toUpperCase()), `${SELLER}>${BUYER}`);
});

test('round truncates to digits and handles junk', () => {
  assert.strictEqual(round(1.23456, 2), 1.23);
  assert.strictEqual(round('x'), 0);
  assert.strictEqual(round(null, 3), 0);
});

test('shortAddr truncates long ids', () => {
  assert.ok(shortAddr(SELLER).includes('…'));
  assert.strictEqual(shortAddr('short'), 'short');
});

// ---- buildFlowGraph --------------------------------------------------------
const leg = (seller, buyer, energyKwh, carbonCc, trades = 1) => ({
  seller,
  buyer,
  energyKwh,
  carbonCc,
  trades,
});

test('buildFlowGraph emits kWh + CC links for a trade', () => {
  const g = buildFlowGraph({ tradeLegs: [leg(SELLER, BUYER, 10, 5)], verifiedMap: new Map() });
  assert.strictEqual(g.links.length, 2);
  assert.ok(g.links.some((l) => l.unit === 'kWh' && l.value === 10));
  assert.ok(g.links.some((l) => l.unit === 'CC' && l.value === 5));
  assert.strictEqual(g.nodes.length, 2);
  assert.strictEqual(g.summary.totalEnergyKwh, 10);
  assert.strictEqual(g.summary.totalCarbonCc, 5);
  assert.strictEqual(g.summary.tradeCount, 1);
});

test('buildFlowGraph aggregates multiple legs for the same pair', () => {
  const g = buildFlowGraph({
    tradeLegs: [leg(SELLER, BUYER, 10, 5), leg(SELLER, BUYER, 3, 2, 2)],
    verifiedMap: new Map(),
  });
  const kwh = g.links.find((l) => l.unit === 'kWh');
  assert.strictEqual(kwh.value, 13);
  assert.strictEqual(kwh.trades, 3);
  assert.strictEqual(g.summary.tradeCount, 3);
});

test('buildFlowGraph ignores self-trades and invalid legs', () => {
  const g = buildFlowGraph({
    tradeLegs: [
      leg(SELLER, SELLER, 10, 5), // self
      leg('', BUYER, 1, 1), // missing seller
      leg(SELLER, null, 1, 1), // missing buyer
    ],
    verifiedMap: new Map(),
  });
  assert.strictEqual(g.links.length, 0);
  assert.strictEqual(g.nodes.length, 0);
});

test('buildFlowGraph drops zero/negative flows', () => {
  const g = buildFlowGraph({
    tradeLegs: [leg(SELLER, BUYER, 0, 0), leg(OTHER, BUYER, -2, -1)],
    verifiedMap: new Map(),
  });
  assert.strictEqual(g.links.length, 0);
});

test('buildFlowGraph derives producer/consumer types + layers', () => {
  // SELLER only exports, BUYER only imports, OTHER does both.
  const g = buildFlowGraph({
    tradeLegs: [
      leg(SELLER, BUYER, 10, 5),
      leg(SELLER, OTHER, 4, 2),
      leg(OTHER, BUYER, 3, 1),
    ],
    verifiedMap: new Map(),
  });
  const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.strictEqual(byId[SELLER].type, 'producer');
  assert.strictEqual(byId[SELLER].layer, 0);
  assert.strictEqual(byId[BUYER].type, 'consumer');
  assert.strictEqual(byId[BUYER].layer, 2);
  assert.strictEqual(byId[OTHER].type, 'prosumer');
  assert.strictEqual(byId[OTHER].layer, 1);
});

test('buildFlowGraph clamps verified energy to traded energy', () => {
  const vm = new Map([[keyPair(SELLER, BUYER), 999]]);
  const g = buildFlowGraph({ tradeLegs: [leg(SELLER, BUYER, 10, 5)], verifiedMap: vm });
  const kwh = g.links.find((l) => l.unit === 'kWh');
  assert.strictEqual(kwh.verifiedEnergyKwh, 10);
  assert.strictEqual(g.summary.verifiedEnergyKwh, 10);
});

test('buildFlowGraph applies verified energy subset correctly', () => {
  const vm = new Map([[keyPair(SELLER, BUYER), 4]]);
  const g = buildFlowGraph({ tradeLegs: [leg(SELLER, BUYER, 10, 5)], verifiedMap: vm });
  const kwh = g.links.find((l) => l.unit === 'kWh');
  assert.strictEqual(kwh.verifiedEnergyKwh, 4);
});

test('buildFlowGraph caps nodes by total flow', () => {
  const legs = [];
  // 5 distinct sellers each selling to BUYER.
  for (let i = 0; i < 5; i++) legs.push(leg(addr(String.fromCharCode(97 + i)), BUYER, 10 - i, 1));
  const g = buildFlowGraph({
    tradeLegs: legs,
    verifiedMap: new Map(),
    opts: { maxNodes: 2, maxLinks: 99 },
  });
  // Only the two highest-total nodes survive: BUYER (Σin=40) + top seller.
  assert.strictEqual(g.nodes.length, 2);
  // Lower-flow sellers are dropped, so only the top seller's link remains.
  assert.ok(g.links.every((l) => g.nodes.some((n) => n.id === l.source)));
  assert.ok(g.links.every((l) => g.nodes.some((n) => n.id === l.target)));
});

test('buildFlowGraph caps links by value', () => {
  const legs = [
    leg(SELLER, BUYER, 100, 50),
    leg(SELLER, OTHER, 1, 1),
    leg(OTHER, BUYER, 2, 2),
  ];
  const g = buildFlowGraph({ tradeLegs: legs, verifiedMap: new Map(), opts: { maxLinks: 1 } });
  // Only the single highest-value link survives (SELLER→BUYER kWh = 100).
  assert.strictEqual(g.links.length, 1);
  assert.strictEqual(g.links[0].value, 100);
});

test('buildFlowGraph handles empty input', () => {
  const g = buildFlowGraph({ tradeLegs: [], verifiedMap: new Map() });
  assert.deepStrictEqual(g.nodes, []);
  assert.deepStrictEqual(g.links, []);
  assert.strictEqual(g.summary.totalEnergyKwh, 0);
  assert.strictEqual(g.summary.tradeCount, 0);
});

test('buildFlowGraph lowercases wallet ids in output', () => {
  const g = buildFlowGraph({
    tradeLegs: [{ seller: SELLER.toUpperCase(), buyer: BUYER.toUpperCase(), energyKwh: 1, carbonCc: 1, trades: 1 }],
    verifiedMap: new Map(),
  });
  assert.ok(g.nodes.every((n) => n.id === n.id.toLowerCase()));
  assert.ok(g.links.every((l) => l.source === l.source.toLowerCase() && l.target === l.target.toLowerCase()));
});
