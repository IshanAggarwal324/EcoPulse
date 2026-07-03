import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeSettlementEvent,
  matchesSettlementEvent,
  TX_HASH_RE,
} from '../settlementSocket.js';

// ---------------------------------------------------------------------------
// Module 9.6 — client-side defense-in-depth for settlement socket events.
//
// The hook trusts `matchesSettlementEvent` as the gate before any state
// mutation. These tests pin that gate so a malformed / non-matching / spoofed
// payload can never short-circuit polling or mutate UI state.
// ---------------------------------------------------------------------------

const TX = '0x' + 'a'.repeat(64);
const OTHER_TX = '0x' + 'b'.repeat(64);
const SELLER = '0x' + '1'.repeat(40);

const validEvent = (over = {}) => ({
  settlementId: 'sett-1',
  txHash: TX,
  listingId: 7,
  verificationStatus: 'mismatch',
  deltaPct: -12.5,
  mismatchFlags: ['UNDER_DELIVERY'],
  ...over,
});

test('normalizeSettlementEvent whitelists fields and drops unknown keys', () => {
  const evt = normalizeSettlementEvent({
    ...validEvent(),
    secret: 'leak',
    nested: { evil: true },
  });
  assert.strictEqual(evt.secret, undefined);
  assert.strictEqual(evt.nested, undefined);
  assert.deepStrictEqual(Object.keys(evt).sort(), [
    'at',
    'deltaPct',
    'listingId',
    'mismatchFlags',
    'settlementId',
    'txHash',
    'verificationStatus',
  ]);
});

test('normalizeSettlementEvent returns null for non-object / junk input', () => {
  assert.strictEqual(normalizeSettlementEvent(null), null);
  assert.strictEqual(normalizeSettlementEvent(undefined), null);
  assert.strictEqual(normalizeSettlementEvent('str'), null);
  assert.strictEqual(normalizeSettlementEvent(42), null);
  assert.strictEqual(normalizeSettlementEvent({ listingId: 1 }), null);
});

test('normalizeSettlementEvent requires a valid 0x+64hex txHash or a settlementId', () => {
  assert.strictEqual(normalizeSettlementEvent({ txHash: '0xdead' }), null);
  // A valid txHash alone is identifiable (stable chain id).
  const ok = normalizeSettlementEvent({ txHash: TX });
  assert.ok(ok, 'a valid txHash alone is enough to identify the event');
  // A settlementId alone is also identifiable.
  assert.ok(normalizeSettlementEvent({ settlementId: 'sett-1' }));
});

test('normalizeSettlementEvent lowercases txHash', () => {
  const evt = normalizeSettlementEvent({ txHash: TX.toUpperCase(), verificationStatus: 'verified' });
  assert.strictEqual(evt.txHash, TX);
});

test('normalizeSettlementEvent coerces bad numerics and filters invalid flags', () => {
  const evt = normalizeSettlementEvent({
    txHash: TX,
    listingId: 'x',
    deltaPct: 'nope',
    mismatchFlags: ['UNDER_DELIVERY', 'bad flag', '', 'EVIL;'],
    verificationStatus: 'bogus',
  });
  assert.strictEqual(evt.listingId, null);
  assert.strictEqual(evt.deltaPct, null);
  assert.strictEqual(evt.verificationStatus, null);
  assert.deepStrictEqual(evt.mismatchFlags, ['UNDER_DELIVERY']);
});

test('matchesSettlementEvent returns true only for the exact tracked txHash (case-insensitive)', () => {
  assert.strictEqual(matchesSettlementEvent(TX, validEvent()), true);
  assert.strictEqual(matchesSettlementEvent(TX.toUpperCase(), validEvent()), true);
});

test('matchesSettlementEvent rejects events for a different trade', () => {
  assert.strictEqual(matchesSettlementEvent(OTHER_TX, validEvent()), false);
});

test('matchesSettlementEvent rejects garbage payloads (never trust the wire)', () => {
  assert.strictEqual(matchesSettlementEvent(TX, null), false);
  assert.strictEqual(matchesSettlementEvent(TX, {}), false);
  assert.strictEqual(matchesSettlementEvent(TX, { txHash: '0xdead' }), false);
  assert.strictEqual(matchesSettlementEvent(TX, 'nope'), false);
});

test('matchesSettlementEvent rejects an invalid tracked txHash itself', () => {
  // Even if the event looks fine, a malformed tracked hash must never match.
  assert.strictEqual(matchesSettlementEvent('not-a-hash', validEvent()), false);
  assert.strictEqual(matchesSettlementEvent(null, validEvent()), false);
  assert.strictEqual(matchesSettlementEvent(undefined, validEvent()), false);
});

test('a txHash-less (settlementId-only) event NEVER matches (no cross-talk)', () => {
  // The backend always emits a txHash, so an id-only event is treated as
  // un-attributable and rejected — it cannot short-circuit any tracker, which
  // prevents one settlement's event from affecting another consumer's state.
  const idOnly = normalizeSettlementEvent({ settlementId: 'sett-1' });
  assert.ok(idOnly && !idOnly.txHash);
  assert.strictEqual(matchesSettlementEvent(TX, idOnly), false);
  assert.strictEqual(matchesSettlementEvent(OTHER_TX, idOnly), false);
});

test('TX_HASH_RE enforces the canonical 0x + 64 hex shape', () => {
  assert.ok(TX_HASH_RE.test(TX));
  assert.ok(TX_HASH_RE.test(TX.toUpperCase()));
  assert.ok(!TX_HASH_RE.test('0xdead'));
  assert.ok(!TX_HASH_RE.test(TX.slice(0, 10)));
  assert.ok(!TX_HASH_RE.test(''));
});

// Sanity: the seller address shape is unrelated to matching (events are
// matched by txHash, not wallet), confirming no wallet-based spoofing vector.
test('a wrong-seller payload still matches by txHash (wallet is not the matcher)', () => {
  assert.strictEqual(matchesSettlementEvent(TX, { ...validEvent(), seller: SELLER }), true);
});
