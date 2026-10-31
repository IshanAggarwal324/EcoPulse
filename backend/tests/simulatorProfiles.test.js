const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeTargets, deterministicNoise, nodeNonce } = require('../services/simulator/profiles');

const solarNode = (id, userId) => ({
  _id: id,
  userId,
  name: id,
  nodeType: 'producer',
  sourceType: 'solar',
  status: 'active',
});

const daySeries = (node, day) =>
  Array.from({ length: 24 }, (_, h) =>
    computeTargets(node, new Date(Date.UTC(2026, 9, day, h, 0))).energyGenerated);

test('same node and timestamp always give the same target (backfill matches live)', () => {
  const node = solarNode('nodeA', 'user1');
  assert.deepEqual(daySeries(node, 20), daySeries(node, 20));
});

test('different owners/nodes (different nonce) get different curves', () => {
  const a = daySeries(solarNode('nodeA', 'user1'), 20);
  const b = daySeries(solarNode('nodeB', 'user2'), 20);
  const c = daySeries(solarNode('nodeC', 'user3'), 20);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notDeepEqual(b, c);
  assert.notEqual(nodeNonce(solarNode('nodeA', 'user1')), nodeNonce(solarNode('nodeA', 'user2')));
});

test('weather differs from day to day for the same node', () => {
  const node = solarNode('nodeA', 'user1');
  const totals = [18, 19, 20, 21, 22, 23].map((d) => daySeries(node, d).reduce((s, v) => s + v, 0));
  assert.ok(new Set(totals.map((t) => t.toFixed(2))).size > 3, 'daily solar output should vary');
});

test('solar is zero at night and positive around local midday', () => {
  const node = solarNode('nodeA', 'user1');
  // Local clock is UTC+5:30 by default: 19:00 UTC is 00:30 local, 07:00 UTC is 12:30 local.
  const night = computeTargets(node, new Date(Date.UTC(2026, 9, 20, 19, 0))).energyGenerated;
  const midday = computeTargets(node, new Date(Date.UTC(2026, 9, 20, 7, 0))).energyGenerated;
  assert.equal(night, 0);
  assert.ok(midday > 1);
});

test('inactive nodes produce nothing, maintenance nodes almost nothing', () => {
  const at = new Date(Date.UTC(2026, 9, 20, 7, 0));
  const inactive = computeTargets({ ...solarNode('n', 'u'), status: 'inactive' }, at);
  assert.deepEqual(inactive, { energyGenerated: 0, energyConsumed: 0 });
  const active = computeTargets(solarNode('n', 'u'), at);
  const maint = computeTargets({ ...solarNode('n', 'u'), status: 'maintenance' }, at);
  assert.ok(maint.energyGenerated < active.energyGenerated);
});

test('measurement noise stays within a few percent and is deterministic', () => {
  const node = solarNode('nodeA', 'user1');
  const at = new Date(Date.UTC(2026, 9, 20, 7, 0));
  const n1 = deterministicNoise(node, at);
  assert.deepEqual(n1, deterministicNoise(node, at));
  assert.ok(n1.generated > 0.94 && n1.generated < 1.06);
  assert.ok(n1.consumed > 0.95 && n1.consumed < 1.05);
});

test('SIMULATOR_NONCE_SALT changes every node curve', () => {
  const node = solarNode('nodeA', 'user1');
  const before = daySeries(node, 20);
  process.env.SIMULATOR_NONCE_SALT = 'another-deployment';
  try {
    assert.notDeepEqual(before, daySeries(node, 20));
  } finally {
    delete process.env.SIMULATOR_NONCE_SALT;
  }
});

test('embedded simulator is allowed in production only with the explicit opt-in', () => {
  const keys = ['SIMULATOR_EMBEDDED', 'NODE_ENV', 'SIMULATOR_ALLOW_IN_PRODUCTION', 'INGESTION_MODE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const load = () => {
    delete require.cache[require.resolve('../services/simulatorManager')];
    return require('../services/simulatorManager');
  };
  try {
    process.env.SIMULATOR_EMBEDDED = 'true';
    process.env.NODE_ENV = 'production';
    process.env.INGESTION_MODE = 'hybrid';
    delete process.env.SIMULATOR_ALLOW_IN_PRODUCTION;
    assert.equal(load().isEmbeddedEnabled(), false);

    process.env.SIMULATOR_ALLOW_IN_PRODUCTION = 'true';
    assert.equal(load().isEmbeddedEnabled(), true);

    // Public-API-only mode still locks the simulator down, opt-in or not.
    process.env.INGESTION_MODE = 'public_api';
    assert.equal(load().isEmbeddedEnabled(), false);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('../services/simulatorManager')];
  }
});

test('embedded transport passes database ObjectId node ids to ingest as strings', async () => {
  const mongoose = require('mongoose');
  const readingService = require('../services/readingService');
  const original = readingService.ingestSimulatedReading;
  const seen = [];
  readingService.ingestSimulatedReading = async (payload) => {
    seen.push(payload);
    // Same check the real pipeline performs (validateReadingInput).
    if (typeof payload.nodeId !== 'string') throw new Error('nodeId must be a valid identifier');
  };
  try {
    delete require.cache[require.resolve('../services/simulatorManager')];
    const { createEmbeddedTransport } = require('../services/simulatorManager');
    const id = new mongoose.Types.ObjectId();
    const result = await createEmbeddedTransport().send({
      nodeId: id,
      name: 'Rooftop Solar Array',
      sourceType: 'solar',
      energyGenerated: 12.5,
      energyConsumed: 1.1,
      timestamp: new Date().toISOString(),
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(typeof seen[0].nodeId, 'string');
    assert.equal(seen[0].nodeId, String(id));
  } finally {
    readingService.ingestSimulatedReading = original;
    delete require.cache[require.resolve('../services/simulatorManager')];
  }
});
