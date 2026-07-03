const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { SOCKET_EVENTS } = require('../socket/events');

// ---------------------------------------------------------------------------
// Module 9.6 — settlement socket scoping (SECURITY).
//
// Settlement lifecycle events carry per-trade private data (txHash, delivery
// delta, mismatch flags). These tests lock down the two production guardrails:
//   1. They are delivered ONLY to the buyer/seller wallet rooms.
//   2. They are NEVER broadcast to the global `authenticated` room, and are
//      dropped (not leaked) when no party wallet is known.
// plus payload sanitization (unknown/invalid fields are stripped).
// ---------------------------------------------------------------------------

const originals = {};
let svc;
let setIo;

const TX = '0x' + 'a'.repeat(64);
const SELLER = '0x' + '1'.repeat(40);
const BUYER = '0x' + '2'.repeat(40);

// Fake io: record every (room, event, payload) emit. `to()` is chainable.
const recorded = [];
const fakeIo = {
  to(room) {
    return {
      emit(event, payload) {
        recorded.push({ room, event, payload });
      },
    };
  },
};

before(() => {
  const analyticsAbs = require.resolve('../services/analytics');
  if (require.cache[analyticsAbs]) originals[analyticsAbs] = require.cache[analyticsAbs];
  // analytics is required at the top of socketBroadcastService; stub it so the
  // service loads without its full dependency tree (same trick as tradeTicker.test.js).
  require.cache[analyticsAbs] = {
    id: analyticsAbs, filename: analyticsAbs, loaded: true, exports: {}, paths: [], children: [],
  };

  const svcPath = require.resolve('../services/socketBroadcastService');
  delete require.cache[svcPath];
  svc = require('../services/socketBroadcastService');
  setIo = svc.setIo;
  setIo(fakeIo);
});

after(() => {
  for (const abs of Object.keys(originals)) require.cache[abs] = originals[abs];
  const analyticsAbs = require.resolve('../services/analytics');
  if (!originals[analyticsAbs]) delete require.cache[analyticsAbs];
  delete require.cache[require.resolve('../services/socketBroadcastService')];
});

const basePayload = () => ({
  settlementId: 'sett-1',
  txHash: TX,
  listingId: 7,
  verificationStatus: 'verified',
  deltaPct: 1.2,
  mismatchFlags: ['UNDER_DELIVERY'],
});

test('emitSettlementVerified targets ONLY the buyer and seller wallet rooms', () => {
  recorded.length = 0;
  svc.emitSettlementVerified(basePayload(), { seller: SELLER, buyer: BUYER });

  const rooms = recorded.map((r) => r.room).sort();
  assert.deepStrictEqual(rooms, [`wallet:${BUYER}`, `wallet:${SELLER}`].sort());
  assert.ok(recorded.every((r) => r.event === SOCKET_EVENTS.SERVER.SETTLEMENT_VERIFIED));
});

test('emitSettlementMismatch targets ONLY wallet rooms under the mismatch event', () => {
  recorded.length = 0;
  svc.emitSettlementMismatch(
    { ...basePayload(), verificationStatus: 'mismatch' },
    { seller: SELLER, buyer: BUYER },
  );

  assert.ok(recorded.every((r) => r.event === SOCKET_EVENTS.SERVER.SETTLEMENT_MISMATCH));
  assert.ok(recorded.every((r) => r.room.startsWith('wallet:')));
});

test('settlement events are NEVER broadcast to the global authenticated room', () => {
  recorded.length = 0;
  svc.emitSettlementVerified(basePayload(), { seller: SELLER, buyer: BUYER });
  svc.emitSettlementMismatch(
    { ...basePayload(), verificationStatus: 'mismatch' },
    { seller: SELLER, buyer: BUYER },
  );
  assert.ok(
    recorded.every((r) => r.room !== 'authenticated'),
    'settlement data must not leak to all authenticated clients',
  );
});

test('wallets are lowercased so they match the room joined from the linked wallet', () => {
  recorded.length = 0;
  svc.emitSettlementVerified(basePayload(), { seller: SELLER.toUpperCase(), buyer: BUYER.toUpperCase() });
  const rooms = recorded.map((r) => r.room);
  assert.ok(rooms.includes(`wallet:${SELLER}`));
  assert.ok(rooms.includes(`wallet:${BUYER}`));
  assert.ok(!rooms.some((r) => r !== r.toLowerCase()));
});

test('a seller-only settlement (null buyer) still reaches the seller and nothing else', () => {
  recorded.length = 0;
  svc.emitSettlementVerified(basePayload(), { seller: SELLER, buyer: null });
  assert.deepStrictEqual(recorded.map((r) => r.room), [`wallet:${SELLER}`]);
});

test('emits are deduped when buyer === seller (single room, single emit)', () => {
  recorded.length = 0;
  svc.emitSettlementVerified(basePayload(), { seller: SELLER, buyer: SELLER });
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].room, `wallet:${SELLER}`);
});

test('with no scoppable wallet the event is DROPPED (no global fallback leak)', () => {
  recorded.length = 0;
  svc.emitSettlementVerified(basePayload(), { seller: null, buyer: null });
  assert.strictEqual(recorded.length, 0);

  // Also when wallets aren't passed and the payload has none either.
  svc.emitSettlementMismatch({ ...basePayload(), seller: undefined }, {});
  assert.strictEqual(recorded.length, 0);
});

test('payload is whitelisted: unknown/injected keys are stripped', () => {
  recorded.length = 0;
  const payload = svc.sanitizeSettlementPayload({
    ...basePayload(),
    secretKey: 'should-not-leak',
    sellerPii: { email: 'x@y.z' },
    nested: { malicious: true },
  });
  assert.strictEqual(payload.secretKey, undefined);
  assert.strictEqual(payload.sellerPii, undefined);
  assert.strictEqual(payload.nested, undefined);
  assert.deepStrictEqual(Object.keys(payload).sort(), [
    'at',
    'deltaPct',
    'listingId',
    'mismatchFlags',
    'settlementId',
    'txHash',
    'verificationStatus',
  ]);
});

test('sanitize drops a payload with no valid txHash AND no settlementId', () => {
  assert.strictEqual(svc.sanitizeSettlementPayload({ listingId: 1, deltaPct: 5 }), null);
  assert.strictEqual(svc.sanitizeSettlementPayload({ txHash: '0xdead' }), null);
  assert.strictEqual(svc.sanitizeSettlementPayload(null), null);
  assert.strictEqual(svc.sanitizeSettlementPayload('nope'), null);
});

test('sanitize coerces bad numeric fields and filters invalid mismatch flags', () => {
  const payload = svc.sanitizeSettlementPayload({
    txHash: TX,
    listingId: 'not-a-number',
    deltaPct: 'oops',
    mismatchFlags: ['UNDER_DELIVERY', 'x y z', '', 'EVIL;', 'READING_GAP'],
    verificationStatus: 'bogus',
  });
  assert.strictEqual(payload.listingId, null);
  assert.strictEqual(payload.deltaPct, null);
  assert.strictEqual(payload.verificationStatus, null);
  assert.deepStrictEqual(payload.mismatchFlags, ['UNDER_DELIVERY', 'READING_GAP']);
});

test('normalizeWallet trims + lowercases and rejects non-strings', () => {
  assert.strictEqual(svc.normalizeWallet('  0xABCDEF  '), '0xabcdef');
  assert.strictEqual(svc.normalizeWallet(null), '');
  assert.strictEqual(svc.normalizeWallet(undefined), '');
  assert.strictEqual(svc.normalizeWallet(123), '');
});

test('emitSettlementVerified emits a valid payload shape to the wire', () => {
  recorded.length = 0;
  svc.emitSettlementVerified(basePayload(), { seller: SELLER });
  const { payload } = recorded[0];
  assert.strictEqual(payload.txHash, TX);
  assert.strictEqual(payload.settlementId, 'sett-1');
  assert.strictEqual(payload.verificationStatus, 'verified');
  assert.ok(typeof payload.at === 'string');
});
