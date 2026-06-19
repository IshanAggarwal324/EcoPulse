const { test } = require('node:test');
const assert = require('node:assert');
const ingestionMode = require('../config/ingestionMode');
const backfillService = require('../services/ingestion/backfillService');

// ── 1.4.1 ingestionMode: defaults + capabilities + lockdown ────────────────

const env = (overrides) => {
  const original = { ...process.env };
  return {
    apply() {
      Object.assign(process.env, overrides);
    },
    restore() {
      process.env = original;
    },
  };
};

test('dev default mode is hybrid (no INGESTION_MODE set)', () => {
  const e = env({ NODE_ENV: 'development' });
  delete process.env.INGESTION_MODE;
  e.apply();
  assert.strictEqual(ingestionMode.getIngestionMode(), 'hybrid');
  e.restore();
});

test('production default mode is public_api (no INGESTION_MODE set)', () => {
  const e = env({ NODE_ENV: 'production' });
  delete process.env.INGESTION_MODE;
  e.apply();
  assert.strictEqual(ingestionMode.getIngestionMode(), 'public_api');
  e.restore();
});

test('explicit valid mode is honored (lowercased)', () => {
  const e = env({ NODE_ENV: 'development', INGESTION_MODE: 'Device' });
  e.apply();
  assert.strictEqual(ingestionMode.getIngestionMode(), 'device');
  e.restore();
});

test('invalid mode falls back to default and flags invalid', () => {
  const e = env({ NODE_ENV: 'development', INGESTION_MODE: 'real_time' });
  e.apply();
  assert.strictEqual(ingestionMode.hasInvalidMode(), true);
  assert.strictEqual(ingestionMode.getIngestionMode(), 'hybrid');
  e.restore();
});

test('capability flags map correctly for each mode', () => {
  const e = env({ NODE_ENV: 'development' });
  e.apply();

  process.env.INGESTION_MODE = 'simulated';
  assert.strictEqual(ingestionMode.isSimulatorAllowed(), true);
  assert.strictEqual(ingestionMode.isDeviceAllowed(), false);
  assert.strictEqual(ingestionMode.isPublicApiAllowed(), false);

  process.env.INGESTION_MODE = 'hybrid';
  assert.strictEqual(ingestionMode.isSimulatorAllowed(), true);
  assert.strictEqual(ingestionMode.isDeviceAllowed(), true);
  assert.strictEqual(ingestionMode.isPublicApiAllowed(), true);

  process.env.INGESTION_MODE = 'public_api';
  assert.strictEqual(ingestionMode.isSimulatorAllowed(), false);
  assert.strictEqual(ingestionMode.isPublicApiAllowed(), true);
  e.restore();
});

test('simulator lockdown only triggers in production + non-simulator mode', () => {
  const e = env({});
  e.apply();

  process.env.NODE_ENV = 'production';
  process.env.INGESTION_MODE = 'public_api';
  assert.strictEqual(ingestionMode.isSimulatorLockedDown(), true);

  process.env.NODE_ENV = 'development';
  assert.strictEqual(ingestionMode.isSimulatorLockedDown(), false);

  process.env.NODE_ENV = 'production';
  process.env.INGESTION_MODE = 'hybrid';
  assert.strictEqual(ingestionMode.isSimulatorLockedDown(), false);
  e.restore();
});

test('getStatus surfaces capabilities + lockdowns', () => {
  const e = env({ NODE_ENV: 'production', INGESTION_MODE: 'public_api' });
  e.apply();
  const status = ingestionMode.getStatus();
  assert.strictEqual(status.mode, 'public_api');
  assert.strictEqual(status.capabilities.simulator, false);
  assert.strictEqual(status.lockdowns.simulatorLockedDown, true);
  assert.strictEqual(status.valid, true);
  e.restore();
});

// ── 1.4.3 backfill: pure validation logic ──────────────────────────────────

test('validateRow rejects invalid nodeId', () => {
  const { error } = backfillService.validateRow(
    { nodeId: 'not-an-id', energyGenerated: 1, energyConsumed: 0 },
    { defaultSource: 'public_api' },
  );
  assert.ok(error);
});

test('validateRow rejects negative / non-numeric energy', () => {
  const ok = '507f1f77bcf86cd799439011';
  assert.ok(backfillService.validateRow({ nodeId: ok, energyGenerated: -1, energyConsumed: 0 }, { defaultSource: 'public_api' }).error);
  assert.ok(backfillService.validateRow({ nodeId: ok, energyGenerated: 'abc', energyConsumed: 0 }, { defaultSource: 'public_api' }).error);
});

test('validateRow builds a stable externalReadingId when none given', () => {
  const { envelope } = backfillService.validateRow(
    { nodeId: '507f1f77bcf86cd799439011', energyGenerated: 5, energyConsumed: 2, timestamp: '2025-01-01T00:00:00Z' },
    { defaultSource: 'public_api' },
  );
  assert.ok(envelope);
  assert.ok(envelope.meta.externalReadingId.startsWith('backfill:'));
  assert.strictEqual(envelope.source, 'public_api');
});

test('validateRow rejects unknown source', () => {
  const { error } = backfillService.validateRow(
    { nodeId: '507f1f77bcf86cd799439011', energyGenerated: 1, energyConsumed: 0, source: 'guessed' },
    { defaultSource: 'public_api' },
  );
  assert.ok(error);
});

test('validateRow preserves an explicit externalReadingId', () => {
  const { envelope } = backfillService.validateRow(
    {
      nodeId: '507f1f77bcf86cd799439011',
      energyGenerated: 1,
      energyConsumed: 0,
      externalReadingId: 'smard:410:DE:t1',
    },
    { defaultSource: 'public_api' },
  );
  assert.strictEqual(envelope.meta.externalReadingId, 'smard:410:DE:t1');
});

test('parseCsv parses a headered CSV with optional columns', () => {
  const csv = 'nodeId,energyGenerated,energyConsumed,timestamp\n507f1f77bcf86cd799439011,12.5,8.0,2025-01-01T00:00:00Z\n507f1f77bcf86cd799439011,10,7,2025-01-01T01:00:00Z';
  const rows = backfillService.parseCsv(csv);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].energyGenerated, 12.5);
  assert.strictEqual(rows[1].timestamp, '2025-01-01T01:00:00Z');
});

test('parseCsv handles BOM, CRLF and blank lines', () => {
  const csv = '\uFEFFnodeId,energyGenerated,energyConsumed\r\n507f1f77bcf86cd799439011,1,0\r\n\r\n';
  const rows = backfillService.parseCsv(csv);
  assert.strictEqual(rows.length, 1);
});

test('getMaxBatchSize respects env and clamps to absolute max', () => {
  const e = env({ INGESTION_BACKFILL_MAX_BATCH: '7' });
  e.apply();
  assert.strictEqual(backfillService.getMaxBatchSize(), 7);
  process.env.INGESTION_BACKFILL_MAX_BATCH = String(10 ** 9);
  assert.strictEqual(backfillService.getMaxBatchSize(), backfillService.ABSOLUTE_MAX_BATCH);
  process.env.INGESTION_BACKFILL_MAX_BATCH = '0';
  assert.strictEqual(backfillService.getMaxBatchSize(), backfillService.DEFAULT_MAX_BATCH);
  e.restore();
});
