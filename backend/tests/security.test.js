const { test } = require('node:test');
const assert = require('node:assert');
const {
  asString,
  asEnum,
  asObjectId,
  escapeRegex,
} = require('../utils/validators');
const { buildTradeQuery, TRADE_EVENT_TYPES } = require('../services/tradeHistoryService');

test('asString returns the value only for real strings', () => {
  assert.strictEqual(asString('hello'), 'hello');
  assert.strictEqual(asString(123), null);
  assert.strictEqual(asString({ $ne: null }), null);
  assert.strictEqual(asString(['listed']), null);
  assert.strictEqual(asString(undefined), null);
  assert.strictEqual(asString(null), null);
});

test('asEnum whitelists only allowed values and rejects objects', () => {
  assert.strictEqual(asEnum('listed', TRADE_EVENT_TYPES), 'listed');
  assert.strictEqual(asEnum('purchased', TRADE_EVENT_TYPES), 'purchased');
  assert.strictEqual(asEnum('pwned', TRADE_EVENT_TYPES), null);
  assert.strictEqual(asEnum({ $ne: null }, TRADE_EVENT_TYPES), null);
  assert.strictEqual(asEnum(undefined, TRADE_EVENT_TYPES), null);
});

test('asObjectId rejects NoSQL operator objects and non-id strings', () => {
  assert.strictEqual(asObjectId({ $gt: '' }), null);
  assert.strictEqual(asObjectId({ $ne: null }), null);
  assert.strictEqual(asObjectId('not-an-id'), null);
  assert.strictEqual(asObjectId(123456), null);
  // A valid 24-hex ObjectId string passes through.
  const validId = '507f1f77bcf86cd799439011';
  assert.strictEqual(asObjectId(validId), validId);
});

test('buildTradeQuery ignores object-injected eventType (no broad data leak)', () => {
  const query = buildTradeQuery({ eventType: { $ne: null } });
  assert.deepStrictEqual(query, {});
});

test('buildTradeQuery ignores unknown eventType strings', () => {
  const query = buildTradeQuery({ eventType: 'pwned' });
  assert.deepStrictEqual(query, {});
});

test('buildTradeQuery includes whitelisted eventType', () => {
  const query = buildTradeQuery({ eventType: 'listed' });
  assert.deepStrictEqual(query, { eventType: 'listed' });
});

test('buildTradeQuery combines wallet + safe eventType safely', () => {
  const query = buildTradeQuery({ wallet: '0xABC', eventType: 'purchased' });
  assert.ok(query.$and);
  const eventTypeCondition = query.$and.find((c) => 'eventType' in c);
  assert.deepStrictEqual(eventTypeCondition, { eventType: 'purchased' });
});

test('escapeRegex escapes regex metacharacters so a RegExp built from it is literal', () => {
  const malicious = '0x.*+$?{}()[]\\abc';
  const escaped = escapeRegex(malicious);
  // The constructed regex should match the literal malicious string, not a pattern.
  const re = new RegExp(`^${escaped}$`);
  assert.ok(re.test(malicious));
  // A classic dot wildcard must NOT match after escaping.
  assert.ok(!new RegExp(`^${escapeRegex('a.b')}$`).test('axb'));
});
