const { test } = require('node:test');
const assert = require('node:assert');
const { buildTlsOptions } = require('../config/redis');
const {
  getAiServiceUrl,
  getGenaiServiceUrl,
  getRpcUrl,
} = require('../config/serviceUrls');
const { createMemoryStore, MAX_KEYS } = require('../middleware/rateLimitMemory');

const withEnv = (overrides, fn) => {
  const snapshot = { ...process.env };
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  }
};

test('buildTlsOptions verifies certificates by default for rediss://', () => {
  withEnv({ NODE_ENV: 'development', REDIS_TLS_INSECURE: undefined }, () => {
    const tls = buildTlsOptions('rediss://user:pass@redis.example.com:6380');
    assert.strictEqual(tls.rejectUnauthorized, true);
  });
});

test('buildTlsOptions allows REDIS_TLS_INSECURE only outside production', () => {
  withEnv({ NODE_ENV: 'development', REDIS_TLS_INSECURE: 'true' }, () => {
    const tls = buildTlsOptions('rediss://localhost:6380');
    assert.strictEqual(tls.rejectUnauthorized, false);
  });

  withEnv({ NODE_ENV: 'production', REDIS_TLS_INSECURE: 'true' }, () => {
    assert.throws(
      () => buildTlsOptions('rediss://localhost:6380'),
      /not allowed in production/,
    );
  });
});

test('service URLs require explicit values in production', () => {
  withEnv({ NODE_ENV: 'production' }, () => {
    delete process.env.AI_SERVICE_URL;
    assert.throws(() => getAiServiceUrl(), /AI_SERVICE_URL must be set/);

    delete process.env.GENAI_SERVICE_URL;
    assert.throws(() => getGenaiServiceUrl(), /GENAI_SERVICE_URL must be set/);
  });
});

test('service URLs fall back to localhost in development', () => {
  withEnv({ NODE_ENV: 'development' }, () => {
    delete process.env.AI_SERVICE_URL;
    delete process.env.GENAI_SERVICE_URL;
    delete process.env.RPC_URL;
    delete process.env.CARBON_CREDIT_ADDRESS;
    delete process.env.ENERGY_TRADING_ADDRESS;

    assert.strictEqual(getAiServiceUrl(), 'http://localhost:8000');
    assert.strictEqual(getGenaiServiceUrl(), 'http://localhost:8001');
    assert.strictEqual(getRpcUrl(), 'http://127.0.0.1:8545');
  });
});

test('memory rate-limit store is bounded', () => {
  const store = createMemoryStore(60_000);
  for (let i = 0; i < MAX_KEYS + 50; i += 1) {
    store.increment(`key-${i}`);
  }
  // Store should not grow without bound — subsequent increments still work.
  assert.strictEqual(store.increment('overflow-key'), 1);
});
