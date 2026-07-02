const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  toPublicStatus,
  isReadyForTraffic,
  projectSafeService,
  probeFrontend,
  probeHttpService,
  probeBackend,
  buildChecks,
  normalizeToContractStatus,
} = require('../services/healthService');

const VALID_STATUSES = ['healthy', 'degraded', 'unhealthy'];

const mockResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

/* ------------------------------------------------------------------ */
/* Public status aggregator — safe-fields projection                   */
/* ------------------------------------------------------------------ */

const sensitiveHealth = {
  schemaVersion: '1.0',
  service: 'ecopulse-backend',
  status: 'degraded',
  checkedAt: new Date().toISOString(),
  uptimeSeconds: 100,
  overall: 'degraded',
  components: {
    mongodb: {
      status: 'up',
      latencyMs: 9,
      details: {
        readyState: 1,
        host: 'mongo-prod.internal', // SENSITIVE
        port: 27017, // SENSITIVE
        name: 'ecopulse_prod', // SENSITIVE
      },
    },
    aiService: {
      status: 'down',
      latencyMs: 4,
      error: 'connect ECONNREFUSED 10.0.0.5:8000', // SENSITIVE (internal IP)
      details: {
        httpStatus: 200,
        status: 'unhealthy',
        model_loaded: false,
        version: '1.4.2', // SENSITIVE (version disclosure)
        checks: [{ id: 'model', status: 'unhealthy' }],
      },
    },
    genaiService: {
      status: 'up',
      latencyMs: 3,
      details: {
        available: true,
        version: '2.0.0', // SENSITIVE
        checks: [{ id: 'gemini', status: 'healthy' }],
      },
    },
    blockchain: {
      status: 'degraded',
      latencyMs: 30,
      details: {
        rpcHost: 'eth-mainnet.g.alchemy.com', // SENSITIVE
        blockNumber: 19500000, // SENSITIVE
        chainId: 1,
        chainName: 'mainnet',
        isSyncHealthy: false,
        syncLagBlocks: 42,
      },
    },
    frontend: { status: 'up', latencyMs: 12, details: { configured: true, httpStatus: 200 } },
    backend: {
      status: 'up',
      latencyMs: 0,
      details: {
        pid: 4242, // SENSITIVE
        nodeVersion: 'v20.11.0', // SENSITIVE
        memory: { heapUsedMb: 120.5 },
        ingestion: { accepted: 5, rejected: 2, duplicate: 1 },
      },
    },
    simulator: { status: 'up', latencyMs: 0, details: { running: true } },
  },
};

test('toPublicStatus returns the services map with status + latency only', () => {
  const pub = toPublicStatus(sensitiveHealth);
  assert.equal(pub.schemaVersion, '1.0');
  assert.equal(pub.service, 'ecopulse-backend');
  assert.ok(VALID_STATUSES.includes(pub.status));
  assert.equal(pub.overall, pub.status); // alias

  const svc = pub.services;
  // ai_service down -> unhealthy in the public view.
  assert.equal(svc.ai_service.status, 'unhealthy');
  assert.equal(svc.ai_service.latencyMs, 4);
  assert.deepEqual(svc.ai_service.details, { model_loaded: false });
  assert.deepEqual(svc.genai_service.details, { available: true }); // available bool is a whitelisted safe field
  assert.equal(svc.genai_service.status, 'healthy');
});

test('toPublicStatus whitelists only safe booleans and omits empty details', () => {
  const pub = toPublicStatus(sensitiveHealth);
  // blockchain exposes only isSyncHealthy; everything else stripped.
  assert.deepEqual(pub.services.blockchain.details, { isSyncHealthy: false });
  // mongodb / backend / frontend / simulator -> no details object at all.
  assert.equal(pub.services.mongodb.details, undefined);
  assert.equal(pub.services.backend.details, undefined);
  assert.equal(pub.services.frontend.details, undefined);
  assert.equal(pub.services.simulator.details, undefined);
});

test('projectSafeService never includes an error field', () => {
  const out = projectSafeService({
    id: 'ai_service',
    status: 'unhealthy',
    latencyMs: 4,
    details: { model_loaded: false },
    error: 'connect ECONNREFUSED 10.0.0.5',
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.details, { model_loaded: false });
});

// SECURITY: the single most important assertion — no sensitive material may
// ever reach an unauthenticated caller of /api/health/status.
test('toPublicStatus leaks no secrets / internal addresses / versions / errors', () => {
  const serialized = JSON.stringify(toPublicStatus(sensitiveHealth));
  const forbidden = [
    'mongo-prod.internal',
    '27017',
    'ecopulse_prod',
    '10.0.0.5',
    'ECONNREFUSED',
    '1.4.2',
    '2.0.0',
    'alchemy.com',
    '19500000',
    'mainnet',
    'v20.11.0',
    '4242',
    'heapUsedMb',
  ];
  for (const token of forbidden) {
    assert.ok(
      !serialized.includes(token),
      `public status leaked sensitive token: ${token}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Readiness decision (availability-preserving)                        */
/* ------------------------------------------------------------------ */

test('isReadyForTraffic is true on healthy and degraded, false only on critical failure', () => {
  assert.equal(isReadyForTraffic({ status: 'healthy' }), true);
  assert.equal(isReadyForTraffic({ status: 'degraded' }), true); // partial degradation stays in rotation
  assert.equal(isReadyForTraffic({ status: 'unhealthy' }), false); // critical down -> 503
  // legacy overall field still understood.
  assert.equal(isReadyForTraffic({ overall: 'down' }), false);
  assert.equal(isReadyForTraffic({ overall: 'degraded' }), true);
});

/* ------------------------------------------------------------------ */
/* Frontend probe                                                      */
/* ------------------------------------------------------------------ */

test('probeFrontend reports up/not-configured when FRONTEND_HEALTH_URL unset', async () => {
  delete process.env.FRONTEND_HEALTH_URL;
  const probe = await probeFrontend();
  assert.equal(probe.status, 'up');
  assert.equal(probe.details.configured, false);
});

test('probeFrontend rejects non-http(s) URLs as down', async () => {
  process.env.FRONTEND_HEALTH_URL = 'ftp://evil.example/health.json';
  const probe = await probeFrontend();
  assert.equal(probe.status, 'down');
  delete process.env.FRONTEND_HEALTH_URL;
});

test('probeFrontend masks the configured host and never echoes the full URL', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => mockResponse(200, { status: 'ok' });
  try {
    process.env.FRONTEND_HEALTH_URL = 'https://cdn.ecopulse.dev/health.json?token=SECRET';
    const probe = await probeFrontend();
    assert.equal(probe.status, 'up');
    assert.equal(probe.url, 'cdn.ecopulse.dev'); // query string + path stripped
    assert.ok(!JSON.stringify(probe).includes('SECRET'));
  } finally {
    delete process.env.FRONTEND_HEALTH_URL;
    global.fetch = originalFetch;
  }
});

test('probeFrontend flags down when the configured host is unreachable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch failed for https://cdn.ecopulse.dev/health.json?token=SECRET');
  };
  try {
    process.env.FRONTEND_HEALTH_URL = 'https://cdn.ecopulse.dev/health.json';
    const probe = await probeFrontend();
    assert.equal(probe.status, 'down');
    assert.ok(!JSON.stringify(probe).includes('SECRET'));
    assert.ok(!JSON.stringify(probe).includes('https://'));
  } finally {
    delete process.env.FRONTEND_HEALTH_URL;
    global.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ */
/* HTTP probe parser alignment (genai 'available' + contract checks)   */
/* ------------------------------------------------------------------ */

test('probeHttpService reads genai available + contract checks (not gemini_status)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    options?.signal?.addEventListener?.('abort', () => {});
    return mockResponse(200, {
      schemaVersion: '1.0',
      status: 'healthy',
      available: true,
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      checks: [{ id: 'gemini', status: 'healthy', latencyMs: 0 }],
    });
  };
  try {
    const probe = await probeHttpService('http://genai.local:8001', { label: 'genai-service' });
    assert.equal(probe.status, 'up');
    assert.equal(probe.details.available, true);
    assert.ok(Array.isArray(probe.details.checks));
    assert.equal(probe.details.checks[0].id, 'gemini');
    assert.equal(probe.details.gemini_status, undefined); // legacy field removed
  } finally {
    global.fetch = originalFetch;
  }
});

test('probeHttpService reads ai_service model_loaded + reflects degraded status', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    options?.signal?.addEventListener?.('abort', () => {});
    return mockResponse(200, {
      schemaVersion: '1.0',
      status: 'degraded',
      model_loaded: false,
      checks: [{ id: 'model', status: 'degraded' }],
    });
  };
  try {
    const probe = await probeHttpService('http://ai.local:8000', { label: 'ai_service' });
    assert.equal(probe.status, 'degraded');
    assert.equal(probe.details.model_loaded, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('probeHttpService scrubs unreachable-host errors (no full URL leak)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('getaddrinfo failed for https://ai.internal:8000?key=LEAKED');
  };
  try {
    const probe = await probeHttpService('http://ai.internal:8000', { label: 'ai_service' });
    assert.equal(probe.status, 'down');
    assert.ok(!JSON.stringify(probe).includes('LEAKED'));
  } finally {
    global.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ */
/* Backend self-probe includes ingestion counters                      */
/* ------------------------------------------------------------------ */

test('probeBackend includes ingestion counters when available', () => {
  const probe = probeBackend();
  assert.equal(probe.status, 'up');
  assert.ok(probe.details.ingestion);
  assert.equal(typeof probe.details.ingestion.accepted, 'number');
});

/* ------------------------------------------------------------------ */
/* buildChecks surfaces the frontend tier                              */
/* ------------------------------------------------------------------ */

test('buildChecks maps frontend component to a frontend check id', () => {
  const checks = buildChecks({ frontend: { status: 'up', latencyMs: 5, details: { configured: true } } });
  assert.equal(checks[0].id, 'frontend');
  assert.equal(checks[0].status, 'healthy');
});

test('toPublicStatus includes all tiers in services (incl. frontend + simulator)', () => {
  const pub = toPublicStatus(sensitiveHealth);
  for (const id of ['mongodb', 'ai_service', 'genai_service', 'blockchain', 'frontend', 'backend', 'simulator']) {
    assert.ok(pub.services[id], `missing service ${id}`);
    assert.ok(VALID_STATUSES.includes(pub.services[id].status));
  }
});
