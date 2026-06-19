const { test } = require('node:test');
const assert = require('node:assert');
const { validateEnvelope, checkCapacity } = require('../services/ingestion/telemetrySchema');
const dedup = require('../services/ingestion/dedup');
const { VALID_SOURCES } = require('../services/readingService');

const VALID_NODE = '507f1f77bcf86cd799439011';

const basePayload = (overrides = {}) => ({
  nodeId: VALID_NODE,
  energyGenerated: 10,
  energyConsumed: 5,
  messageId: 'msg-1',
  ...overrides,
});

// ── 1.2.2 payload validation ──────────────────────────────────────────────

test('validateEnvelope accepts a well-formed telemetry envelope', () => {
  const r = validateEnvelope(basePayload());
  assert.ok(r.ok);
  assert.strictEqual(r.normalized.nodeId, VALID_NODE);
  assert.strictEqual(r.normalized.unit, 'kW');
  assert.strictEqual(r.normalized.timestamp, null);
});

test('validateEnvelope rejects non-object payloads', () => {
  assert.strictEqual(validateEnvelope(null).ok, false);
  assert.strictEqual(validateEnvelope('str').ok, false);
  assert.strictEqual(validateEnvelope([]).ok, false);
});

test('validateEnvelope rejects invalid nodeId', () => {
  const r = validateEnvelope(basePayload({ nodeId: 'not-an-id' }));
  assert.ok(!r.ok);
  assert.strictEqual(r.code, 'INVALID_NODE_ID');
});

test('validateEnvelope rejects non-finite / negative energy values', () => {
  assert.strictEqual(validateEnvelope(basePayload({ energyGenerated: 'x' })).code, 'INVALID_GENERATED');
  assert.strictEqual(validateEnvelope(basePayload({ energyConsumed: NaN })).code, 'INVALID_CONSUMED');
  assert.strictEqual(validateEnvelope(basePayload({ energyGenerated: -1 })).code, 'NEGATIVE_VALUE');
});

test('validateEnvelope rejects absurd values beyond absolute ceiling', () => {
  const r = validateEnvelope(basePayload({ energyGenerated: 1e12 }));
  assert.strictEqual(r.code, 'OUT_OF_RANGE');
});

test('validateEnvelope rejects malformed messageId and unit', () => {
  assert.strictEqual(validateEnvelope(basePayload({ messageId: 123 })).code, 'INVALID_MESSAGE_ID');
  assert.strictEqual(validateEnvelope(basePayload({ unit: 'GW' })).code, 'INVALID_UNIT');
});

test('validateEnvelope enforces clock-skew window and can be disabled', () => {
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const r = validateEnvelope(basePayload({ timestamp: future }));
  assert.ok(!r.ok);
  assert.strictEqual(r.code, 'CLOCK_SKEW');

  const original = process.env.ALLOW_CLOCK_SKEW;
  process.env.ALLOW_CLOCK_SKEW = 'true';
  const r2 = validateEnvelope(basePayload({ timestamp: future }));
  assert.ok(r2.ok, 'ALLOW_CLOCK_SKEW=true disables skew check');
  if (original === undefined) delete process.env.ALLOW_CLOCK_SKEW;
  else process.env.ALLOW_CLOCK_SKEW = original;
});

test('validateEnvelope rejects unparseable timestamps', () => {
  const r = validateEnvelope(basePayload({ timestamp: 'not-a-date' }));
  assert.strictEqual(r.code, 'INVALID_TIMESTAMP');
});

// ── 1.2.2 capacity checks ─────────────────────────────────────────────────

test('checkCapacity passes when no caps configured', () => {
  assert.ok(checkCapacity({ energyGenerated: 999, energyConsumed: 1, node: {}, device: null }).ok);
});

test('checkCapacity uses the most restrictive of node/device caps with 10% tolerance', () => {
  const node = { maxCapacityKw: 100 };
  const device = { maxCapacityKw: 50 };
  // peak 55 <= 50*1.1=55 → allowed at boundary
  assert.ok(checkCapacity({ energyGenerated: 55, energyConsumed: 0, node, device }).ok);
  // peak 56 > 55 → rejected
  assert.ok(!checkCapacity({ energyGenerated: 56, energyConsumed: 0, node, device }).ok);
});

// ── 1.2.3 dedup ───────────────────────────────────────────────────────────

test('dedup marks a messageId as seen on first call, duplicate on second', async () => {
  dedup.clear();
  const scopeId = 'dev_test';
  const messageId = `uuid-${Date.now()}`;
  const first = await dedup.checkAndMark({ scopeId, messageId });
  const second = await dedup.checkAndMark({ scopeId, messageId });
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);
});

test('dedup treats different messageIds as non-duplicate', async () => {
  dedup.clear();
  const scopeId = 'dev_test2';
  const a = await dedup.checkAndMark({ scopeId, messageId: 'a' });
  const b = await dedup.checkAndMark({ scopeId, messageId: 'b' });
  assert.strictEqual(a.duplicate, false);
  assert.strictEqual(b.duplicate, false);
});

test('dedup returns non-duplicate when ids are missing (no false rejects)', async () => {
  const r = await dedup.checkAndMark({ scopeId: null, messageId: null });
  assert.strictEqual(r.duplicate, false);
});

// ── 1.2.4 / 1.2.6 unified pipeline constants ─────────────────────────────

test('VALID_SOURCES contains the four canonical sources', () => {
  assert.deepStrictEqual([...VALID_SOURCES].sort(), ['admin', 'device', 'public_api', 'simulated']);
});
