const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  toHealthContract,
  normalizeToContractStatus,
  deriveContractStatus,
  buildChecks,
  deriveOverall,
  scrubMessage,
  maskUrlHost,
  HEALTH_SCHEMA_VERSION,
  BACKEND_SERVICE_NAME,
} = require('../services/healthService');

/* ------------------------------------------------------------------ */
/* Schema sanity                                                       */
/* ------------------------------------------------------------------ */

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'shared', 'healthContract.json');
const VALID_STATUSES = ['healthy', 'degraded', 'unhealthy'];

const loadSchema = () => JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

test('shared health contract schema is valid JSON with the expected shape', () => {
  const schema = loadSchema();
  assert.equal(schema.title, 'EcoPulse Health Contract');
  assert.equal(schema.version, '1.0');
  for (const field of ['schemaVersion', 'service', 'status', 'checkedAt', 'uptimeSeconds', 'checks']) {
    assert.ok(schema.required.includes(field), `missing required field ${field}`);
  }
  assert.deepEqual(schema.properties.status.enum.sort(), VALID_STATUSES.sort());
});

// Minimal structural validator mirroring the JSON Schema (no ajv dependency).
const assertConforms = (payload) => {
  assert.equal(payload.schemaVersion, '1.0', 'schemaVersion must be 1.0');
  assert.equal(typeof payload.service, 'string');
  assert.ok(payload.service.length > 0, 'service must be non-empty');
  assert.ok(VALID_STATUSES.includes(payload.status), `status must be a contract enum, got ${payload.status}`);
  assert.ok(!Number.isNaN(Date.parse(payload.checkedAt)), 'checkedAt must be ISO-8601');
  assert.ok(Number.isInteger(payload.uptimeSeconds) && payload.uptimeSeconds >= 0, 'uptimeSeconds must be a non-negative integer');
  assert.ok(Array.isArray(payload.checks), 'checks must be an array');
  for (const check of payload.checks) {
    assert.equal(typeof check.id, 'string');
    assert.ok(check.id.length > 0, 'check.id non-empty');
    assert.ok(VALID_STATUSES.includes(check.status), `check.status enum, got ${check.status}`);
    if (check.latencyMs !== null && check.latencyMs !== undefined) {
      assert.ok(typeof check.latencyMs === 'number' && check.latencyMs >= 0, 'latencyMs non-negative number');
    }
    if (check.details !== undefined) assert.equal(typeof check.details, 'object');
  }
};

/* ------------------------------------------------------------------ */
/* Status normalization                                                */
/* ------------------------------------------------------------------ */

test('normalizeToContractStatus maps internal statuses to the contract enum', () => {
  assert.equal(normalizeToContractStatus('up'), 'healthy');
  assert.equal(normalizeToContractStatus('healthy'), 'healthy');
  assert.equal(normalizeToContractStatus('ok'), 'healthy');
  assert.equal(normalizeToContractStatus('degraded'), 'degraded');
  assert.equal(normalizeToContractStatus('partial'), 'degraded');
  assert.equal(normalizeToContractStatus('down'), 'unhealthy');
  assert.equal(normalizeToContractStatus('error'), 'unhealthy');
  // Fail-closed for unknown/empty values.
  assert.equal(normalizeToContractStatus(''), 'unhealthy');
  assert.equal(normalizeToContractStatus(undefined), 'unhealthy');
  assert.equal(normalizeToContractStatus('weird'), 'unhealthy');
});

/* ------------------------------------------------------------------ */
/* Worst-status derivation                                             */
/* ------------------------------------------------------------------ */

test('deriveContractStatus takes the worst of overall + checks', () => {
  assert.equal(
    deriveContractStatus('healthy', [{ status: 'healthy' }]),
    'healthy',
  );
  assert.equal(
    deriveContractStatus('healthy', [{ status: 'degraded' }]),
    'degraded',
  );
  // A failing dependency must never read as healthy even if overall is healthy.
  assert.equal(
    deriveContractStatus('healthy', [{ status: 'healthy' }, { status: 'unhealthy' }]),
    'unhealthy',
  );
  assert.equal(
    deriveContractStatus('degraded', [{ status: 'unhealthy' }]),
    'unhealthy',
  );
});

/* ------------------------------------------------------------------ */
/* buildChecks maps components -> contract checks                      */
/* ------------------------------------------------------------------ */

test('buildChecks normalizes component statuses and renames keys to check ids', () => {
  const checks = buildChecks({
    mongodb: { status: 'up', latencyMs: 12.4, details: { readyState: 1 } },
    aiService: { status: 'down', latencyMs: 5, error: 'unreachable' },
    genaiService: { status: 'degraded', latencyMs: 3, details: {} },
  });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId.mongodb.status, 'healthy');
  assert.equal(byId.mongodb.latencyMs, 12); // rounded
  assert.equal(byId.ai_service.status, 'unhealthy');
  assert.equal(byId.ai_service.error, 'unreachable');
  assert.equal(byId.genai_service.status, 'degraded');
});

test('buildChecks tolerates missing/odd probe shapes without throwing', () => {
  const checks = buildChecks({ something: null, other: {} });
  assert.equal(checks[0].status, 'unhealthy'); // null -> fail-closed
  assert.equal(checks[0].latencyMs, null);
  assert.equal(checks[1].id, 'other');
});

/* ------------------------------------------------------------------ */
/* toHealthContract end-to-end                                         */
/* ------------------------------------------------------------------ */

const sampleHealth = {
  overall: 'degraded',
  checkedAt: new Date().toISOString(),
  components: {
    mongodb: { status: 'up', latencyMs: 10, details: { readyState: 1 } },
    aiService: { status: 'down', latencyMs: 4, error: 'connection refused' },
    genaiService: { status: 'up', latencyMs: 2, details: {} },
    blockchain: { status: 'degraded', latencyMs: 30, details: { syncLagBlocks: 12 } },
    backend: { status: 'up', latencyMs: 0, details: {} },
    simulator: { status: 'up', latencyMs: 0, details: {} },
  },
};

test('toHealthContract produces a schema-conformant contract with worst status', () => {
  const contract = toHealthContract(sampleHealth);
  assertConforms(contract);
  assert.equal(contract.service, BACKEND_SERVICE_NAME);
  assert.equal(contract.schemaVersion, HEALTH_SCHEMA_VERSION);
  // aiService is down (unhealthy) -> overall contract status must be unhealthy.
  assert.equal(contract.status, 'unhealthy');
  assert.ok(contract.checks.length >= 6);
});

test('toHealthContract reads healthy when everything is up', () => {
  const healthy = {
    overall: 'healthy',
    checkedAt: new Date().toISOString(),
    components: {
      mongodb: { status: 'up', latencyMs: 5, details: {} },
      backend: { status: 'up', latencyMs: 0, details: {} },
    },
  };
  const contract = toHealthContract(healthy);
  assertConforms(contract);
  assert.equal(contract.status, 'healthy');
});

test('toHealthContract handles empty/missing components', () => {
  const contract = toHealthContract({ overall: 'healthy', checkedAt: new Date().toISOString() });
  assertConforms(contract);
  assert.equal(contract.status, 'healthy');
  assert.equal(contract.checks.length, 0);
});

/* ------------------------------------------------------------------ */
/* Regression: legacy deriveOverall unchanged                          */
/* ------------------------------------------------------------------ */

test('deriveOverall still marks critical dependency outage as down (legacy)', () => {
  assert.equal(
    deriveOverall({ mongodb: { status: 'down' }, backend: { status: 'up' } }),
    'down',
  );
  assert.equal(
    deriveOverall({ mongodb: { status: 'up' }, backend: { status: 'up' } }),
    'healthy',
  );
});

/* ------------------------------------------------------------------ */
/* Security: secrets must never leak into health details               */
/* ------------------------------------------------------------------ */

test('scrubMessage strips RPC URLs and provider hostnames/keys from errors', () => {
  const secretUrl = 'https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETAPIKEY123';
  const scrubbed = scrubMessage(`fetch failed for ${secretUrl}`);
  assert.ok(!scrubbed.includes('SUPERSECRETAPIKEY123'), 'API key leaked');
  assert.ok(!scrubbed.includes('https://'), 'raw URL leaked');
  assert.ok(scrubbed.includes('[host]') || scrubbed.includes('[url]'));
});

test('scrubMessage truncates very long error strings', () => {
  const long = 'x'.repeat(1000);
  assert.ok(scrubMessage(long).length <= 240);
});

test('maskUrlHost reduces a full RPC URL to its hostname only', () => {
  assert.equal(
    maskUrlHost('https://eth-mainnet.g.alchemy.com/v2/SECRETKEY'),
    'eth-mainnet.g.alchemy.com',
  );
  assert.equal(maskUrlHost('not-a-url'), null);
  assert.equal(maskUrlHost(null), null);
});

test('a contract built from a scrubbed probe carries no secret material', () => {
  const contract = toHealthContract({
    overall: 'down',
    checkedAt: new Date().toISOString(),
    components: {
      blockchain: {
        status: 'down',
        latencyMs: 1,
        error: scrubMessage('getaddr failed for https://eth.g.alchemy.com/v2/LEAKEDKEY'),
        details: { rpcHost: maskUrlHost('https://eth.g.alchemy.com/v2/LEAKEDKEY') },
      },
      backend: { status: 'up', latencyMs: 0, details: {} },
    },
  });
  assertConforms(contract);
  const serialized = JSON.stringify(contract);
  assert.ok(!serialized.includes('LEAKEDKEY'), 'secret key leaked into contract');
  assert.ok(!serialized.includes('/v2/'), 'RPC path leaked into contract');
});
