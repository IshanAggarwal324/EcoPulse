const { test } = require('node:test');
const assert = require('node:assert');

const { logger, runWithContext, getCorrelationId, getTraceparent, logBackgroundError } = require('../utils/logger');
const {
  sanitizeCorrelationId,
  resolveCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
  sanitizeTraceparent,
  resolveTraceparent,
  generateTraceparent,
} = require('../utils/correlation');
const { fetchWithTimeout, buildOutboundHeaders } = require('../utils/fetchWithTimeout');
const correlationIdMiddleware = require('../middleware/correlationId');
const { renderMetrics, recordHttpRequest, normalizeRoute, recordDependencyHealth } = require('../services/metrics/prometheus');
const { isMetricsEnabled, authorizeMetrics, safeEqual } = require('../routes/metrics');
const ingestionMetrics = require('../services/ingestion/ingestionMetrics');

/* ------------------------------------------------------------------ */
/* H16 — structured logger                                             */
/* ------------------------------------------------------------------ */

test('logger emits JSON with level and message', () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    logger.info('test event', { component: 'test' });
    const parsed = JSON.parse(chunks[0].trim());
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.msg, 'test event');
    assert.strictEqual(parsed.component, 'test');
    assert.ok(parsed.ts);
  } finally {
    process.stdout.write = original;
  }
});

test('runWithContext attaches correlationId to log entries', () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    runWithContext({ correlationId: 'corr-123' }, () => {
      logger.info('scoped event');
    });
    const parsed = JSON.parse(chunks[0].trim());
    assert.strictEqual(parsed.correlationId, 'corr-123');
  } finally {
    process.stdout.write = original;
  }
});

test('logBackgroundError writes warn-level structured log', () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };

  try {
    logBackgroundError('test.scope', new Error('boom'), { foo: 'bar' });
    const parsed = JSON.parse(chunks[0].trim());
    assert.strictEqual(parsed.level, 'warn');
    assert.strictEqual(parsed.scope, 'test.scope');
    assert.strictEqual(parsed.foo, 'bar');
    assert.strictEqual(parsed.err.message, 'boom');
  } finally {
    process.stdout.write = original;
  }
});

/* ------------------------------------------------------------------ */
/* H17 — Prometheus metrics                                            */
/* ------------------------------------------------------------------ */

test('renderMetrics includes ingestion and process gauges', () => {
  ingestionMetrics.reset();
  ingestionMetrics.recordAccepted({ source: 'device', transport: 'mqtt' });

  const body = renderMetrics();
  assert.match(body, /ecopulse_ingestion_accepted_total/);
  assert.match(body, /ecopulse_process_uptime_seconds/);
  assert.match(body, /ecopulse_nodejs_heap_used_bytes/);
});

test('recordHttpRequest increments request counters', () => {
  recordHttpRequest({
    method: 'GET',
    route: '/api/health',
    statusCode: 200,
    durationMs: 12,
  });

  const body = renderMetrics();
  assert.match(body, /ecopulse_http_requests_total\{method="GET",route="\/api\/health",status="200"\}/);
});

test('normalizeRoute prefers express route path', () => {
  const req = {
    baseUrl: '/api/v1',
    route: { path: '/nodes' },
    path: '/api/v1/nodes',
  };
  assert.strictEqual(normalizeRoute(req), '/api/v1/nodes');
});

/* ------------------------------------------------------------------ */
/* Module 7.4 — correlation id sanitization & propagation              */
/* ------------------------------------------------------------------ */

test('sanitizeCorrelationId keeps safe chars and strips everything else', () => {
  assert.strictEqual(sanitizeCorrelationId('abc-123_xyz'), 'abc-123_xyz');
  // Control chars (CR/LF) — the log-forging / header-injection vector — must be removed.
  assert.strictEqual(sanitizeCorrelationId('a\rb\nc'), 'abc');
  // Quotes, semicolons, spaces, slashes: none survive.
  assert.strictEqual(sanitizeCorrelationId('ev"il; /etc/'), 'eviletc');
  assert.strictEqual(sanitizeCorrelationId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
});

test('sanitizeCorrelationId rejects empty / over-length / null', () => {
  assert.strictEqual(sanitizeCorrelationId(null), null);
  assert.strictEqual(sanitizeCorrelationId(undefined), null);
  assert.strictEqual(sanitizeCorrelationId(''), null);
  assert.strictEqual(sanitizeCorrelationId('   '), null);
  // A payload made entirely of disallowed chars yields nothing usable.
  assert.strictEqual(sanitizeCorrelationId('\r\n\r\n'), null);
  // Over-length value (DoS / log-bloat vector) is rejected entirely.
  assert.strictEqual(sanitizeCorrelationId('a'.repeat(MAX_CORRELATION_ID_LENGTH)), 'a'.repeat(MAX_CORRELATION_ID_LENGTH));
  assert.strictEqual(sanitizeCorrelationId('a'.repeat(MAX_CORRELATION_ID_LENGTH + 1)), null);
});

test('resolveCorrelationId returns sanitized input or a fresh UUID', () => {
  assert.strictEqual(resolveCorrelationId('good-id'), 'good-id');
  const generated = resolveCorrelationId('bad value!');
  assert.notStrictEqual(generated, 'bad value!');
  assert.match(generated, /^[A-Za-z0-9_-]+$/);
  assert.ok(generated.length > 0 && generated.length <= MAX_CORRELATION_ID_LENGTH);
  // Two absent-header resolutions are distinct UUIDs.
  assert.notStrictEqual(resolveCorrelationId(undefined), resolveCorrelationId(undefined));
});

test('correlationId middleware echoes a sanitized x-request-id', () => {
  const captured = { id: null };
  const req = { get: (h) => (h === 'x-request-id' ? 'ev"il\r\nINJECT' : undefined) };
  const res = { setHeader: (k, v) => { captured[k] = v; } };
  correlationIdMiddleware(req, res, () => {});
  assert.strictEqual(captured.id, null);
  assert.strictEqual(captured['x-request-id'], 'evilINJECT');
  assert.match(captured['x-request-id'], /^[A-Za-z0-9_-]+$/);
  assert.strictEqual(req.correlationId, 'evilINJECT');
});

test('correlationId middleware generates an id when header is absent', () => {
  const captured = {};
  const req = { get: () => undefined };
  const res = { setHeader: (k, v) => { captured[k] = v; } };
  correlationIdMiddleware(req, res, () => {});
  assert.match(captured['x-request-id'], /^[A-Za-z0-9_-]+$/);
  assert.ok(captured['x-request-id'].length > 0);
  assert.strictEqual(req.correlationId, captured['x-request-id']);
});

test('buildOutboundHeaders forwards the context correlation id', async () => {
  let headers;
  await runWithContext({ correlationId: 'ctx-cid-9' }, () => {
    headers = buildOutboundHeaders({ 'Content-Type': 'application/json' });
  });
  assert.strictEqual(headers['x-request-id'], 'ctx-cid-9');
  assert.strictEqual(headers['Content-Type'], 'application/json');
});

test('buildOutboundHeaders omits header when no context is active', () => {
  const headers = buildOutboundHeaders({ Accept: 'application/json' });
  assert.ok(!('x-request-id' in headers));
  assert.strictEqual(headers.Accept, 'application/json');
});

test('buildOutboundHeaders sanitizes a caller-supplied x-request-id (case-insensitive)', () => {
  const headers = buildOutboundHeaders({ 'X-Request-Id': 'a\rb;c d' });
  assert.strictEqual(headers['x-request-id'], 'abcd');
  assert.ok(!('X-Request-Id' in headers));
});

test('buildOutboundHeaders drops a fully-malformed caller header and does not leak context', () => {
  // No active context here, and a garbage caller header -> no id forwarded
  // (never send an untrusted/invalid value downstream).
  const headers = buildOutboundHeaders({ 'x-request-id': '\r\n\r\n' });
  assert.ok(!('x-request-id' in headers));
});

test('fetchWithTimeout forwards x-request-id from the request context', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return Promise.resolve({ ok: true, status: 200 });
  };
  try {
    await runWithContext({ correlationId: 'req-777' }, async () => {
      await fetchWithTimeout('http://internal.test/p', { method: 'POST' });
    });
    assert.strictEqual(calls[0].headers['x-request-id'], 'req-777');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchWithTimeout does not add x-request-id outside a request context', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => {
    calls.push(opts.headers);
    return Promise.resolve({ ok: true, status: 200 });
  };
  try {
    assert.strictEqual(getCorrelationId(), null);
    await fetchWithTimeout('http://internal.test/p');
    assert.ok(!('x-request-id' in calls[0]));
  } finally {
    global.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ */
/* Module 7.5 — dependency health gauge                                */
/* ------------------------------------------------------------------ */

const VALID_TP = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

test('recordDependencyHealth emits a gauge per dependency with mapped values', () => {
  recordDependencyHealth([
    { id: 'mongodb', status: 'healthy' },
    { id: 'ai_service', status: 'degraded' },
    { id: 'blockchain', status: 'down' },
    { id: 'genai_service', status: 'up' },
    { id: 'unknown_thing', status: 'bogus' },
  ]);

  const body = renderMetrics();
  assert.match(body, /# TYPE ecopulse_dependency_health gauge/);
  assert.match(body, /ecopulse_dependency_health\{service="mongodb"\} 1/);
  assert.match(body, /ecopulse_dependency_health\{service="ai_service"\} 0\.5/);
  assert.match(body, /ecopulse_dependency_health\{service="blockchain"\} 0/);
  assert.match(body, /ecopulse_dependency_health\{service="genai_service"\} 1/);
  // Unknown statuses fail closed to 0.
  assert.match(body, /ecopulse_dependency_health\{service="unknown_thing"\} 0/);
});

test('recordDependencyHealth is robust to empty/undefined checks', () => {
  assert.doesNotThrow(() => recordDependencyHealth(undefined));
  assert.doesNotThrow(() => recordDependencyHealth([]));
});

/* ------------------------------------------------------------------ */
/* Module 7.6 — W3C traceparent validation                             */
/* ------------------------------------------------------------------ */

test('sanitizeTraceparent accepts a well-formed value and lowercases it', () => {
  assert.strictEqual(sanitizeTraceparent(VALID_TP), VALID_TP);
  assert.strictEqual(
    sanitizeTraceparent(VALID_TP.toUpperCase()),
    VALID_TP,
  );
});

test('sanitizeTraceparent rejects malformed / hostile values', () => {
  // Log-forging / header-injection vectors must never survive.
  assert.strictEqual(sanitizeTraceparent('00-\r\nINJECT-b-c-01'), null);
  assert.strictEqual(sanitizeTraceparent('not a traceparent'), null);
  assert.strictEqual(sanitizeTraceparent('00-' + 'a'.repeat(31) + '-' + 'b'.repeat(16) + '-01'), null); // short trace id
  assert.strictEqual(sanitizeTraceparent(`ff-${'a'.repeat(32)}-${'b'.repeat(16)}-01`), null); // forbidden version
  assert.strictEqual(sanitizeTraceparent(`00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`), null); // all-zero trace id
  assert.strictEqual(sanitizeTraceparent(`00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`), null); // all-zero parent id
  assert.strictEqual(sanitizeTraceparent(null), null);
  assert.strictEqual(sanitizeTraceparent(undefined), null);
  assert.strictEqual(sanitizeTraceparent(''), null);
});

test('generateTraceparent is schema-conformant', () => {
  const tp = generateTraceparent();
  assert.match(tp, /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  assert.strictEqual(sanitizeTraceparent(tp), tp);
  // Two generations are distinct (fresh randomness).
  assert.notStrictEqual(generateTraceparent(), generateTraceparent());
});

test('resolveTraceparent trusts valid input, mints fresh otherwise', () => {
  assert.strictEqual(resolveTraceparent(VALID_TP), VALID_TP);
  const fresh = resolveTraceparent('garbage');
  assert.notStrictEqual(fresh, 'garbage');
  assert.strictEqual(sanitizeTraceparent(fresh), fresh);
});

/* ------------------------------------------------------------------ */
/* Module 7.6 — traceparent outbound propagation                        */
/* ------------------------------------------------------------------ */

test('buildOutboundHeaders forwards the context traceparent', async () => {
  let headers;
  await runWithContext({ correlationId: 'cid-1', traceparent: VALID_TP }, () => {
    headers = buildOutboundHeaders({ Accept: 'application/json' });
  });
  assert.strictEqual(headers.traceparent, VALID_TP);
  assert.strictEqual(headers['x-request-id'], 'cid-1');
});

test('buildOutboundHeaders omits traceparent when no context is active', () => {
  assert.strictEqual(getTraceparent(), null);
  const headers = buildOutboundHeaders({ Accept: 'application/json' });
  assert.ok(!('traceparent' in headers));
});

test('buildOutboundHeaders validates a caller-supplied traceparent (case-insensitive)', () => {
  const headers = buildOutboundHeaders({ Traceparent: VALID_TP });
  assert.strictEqual(headers.traceparent, VALID_TP);
  assert.ok(!('Traceparent' in headers));
});

test('buildOutboundHeaders drops a malformed caller traceparent and leaks nothing', () => {
  const headers = buildOutboundHeaders({ traceparent: 'evil\r\nINJECT' });
  assert.ok(!('traceparent' in headers));
});

test('fetchWithTimeout forwards traceparent from the request context', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => {
    calls.push(opts.headers);
    return Promise.resolve({ ok: true, status: 200 });
  };
  try {
    await runWithContext({ correlationId: 'cid-9', traceparent: VALID_TP }, async () => {
      await fetchWithTimeout('http://internal.test/p', { method: 'POST' });
    });
    assert.strictEqual(calls[0].traceparent, VALID_TP);
  } finally {
    global.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ */
/* Module 7.6 — traceparent in the correlation middleware               */
/* ------------------------------------------------------------------ */

const withEnv = (overrides, fn) => {
  const backup = {};
  for (const [k, v] of Object.entries(overrides)) {
    backup[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test('correlation middleware echoes a valid inbound traceparent', () => {
  withEnv({}, () => {
    const captured = {};
    const req = {
      get: (h) =>
        h === 'x-request-id' ? 'abc-123' : h === 'traceparent' ? VALID_TP : undefined,
    };
    const res = { setHeader: (k, v) => { captured[k] = v; } };
    correlationIdMiddleware(req, res, () => {});
    assert.strictEqual(captured['x-request-id'], 'abc-123');
    assert.strictEqual(captured.traceparent, VALID_TP);
    assert.strictEqual(req.traceparent, VALID_TP);
  });
});

test('correlation middleware rejects a malformed inbound traceparent and mints fresh', () => {
  withEnv({}, () => {
    const captured = {};
    const req = {
      get: (h) =>
        h === 'x-request-id'
          ? 'abc-123'
          : h === 'traceparent'
            ? 'evil\r\nINJECT'
            : undefined,
    };
    const res = { setHeader: (k, v) => { captured[k] = v; } };
    correlationIdMiddleware(req, res, () => {});
    // Never trust the hostile value; a fresh valid context replaces it.
    assert.match(captured.traceparent, /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    assert.strictEqual(sanitizeTraceparent(captured.traceparent), captured.traceparent);
  });
});

test('correlation middleware can opt out of traceparent generation', () => {
  withEnv({ TRACEPARENT_ENABLED: 'false' }, () => {
    const captured = {};
    const req = { get: (h) => (h === 'x-request-id' ? 'abc-123' : undefined) };
    const res = { setHeader: (k, v) => { captured[k] = v; } };
    correlationIdMiddleware(req, res, () => {});
    assert.strictEqual(captured.traceparent, undefined);
    assert.strictEqual(req.traceparent, undefined);
  });
});

/* ------------------------------------------------------------------ */
/* Module 7.5 — /metrics route security guard rails                    */
/* ------------------------------------------------------------------ */

test('isMetricsEnabled is disabled by METRICS_ENABLED=false', () => {
  withEnv({ METRICS_ENABLED: 'false', NODE_ENV: 'development' }, () => {
    assert.strictEqual(isMetricsEnabled(), false);
  });
});

test('isMetricsEnabled stays open in dev without a token', () => {
  withEnv({ METRICS_ENABLED: 'true', NODE_ENV: 'development', METRICS_TOKEN: '' }, () => {
    assert.strictEqual(isMetricsEnabled(), true);
  });
});

test('isMetricsEnabled refuses open access in production without a token', () => {
  withEnv({ METRICS_ENABLED: 'true', NODE_ENV: 'production', METRICS_TOKEN: '' }, () => {
    assert.strictEqual(isMetricsEnabled(), false);
  });
});

test('isMetricsEnabled is enabled in production when a token is configured', () => {
  withEnv({ METRICS_ENABLED: 'true', NODE_ENV: 'production', METRICS_TOKEN: 'scraper-secret' }, () => {
    assert.strictEqual(isMetricsEnabled(), true);
  });
});

test('authorizeMetrics rejects wrong/absent tokens', () => {
  withEnv({ NODE_ENV: 'production', METRICS_TOKEN: 'scraper-secret' }, () => {
    const blocked = { set: false };
    const res401 = {
      status: (c) => { blocked.code = c; return res401; },
      set: () => res401,
      send: () => { blocked.set = true; },
    };
    assert.strictEqual(authorizeMetrics({ get: () => undefined }, res401), false);
    assert.strictEqual(blocked.code, 401);

    const wrong = {
      status: (c) => { blocked.code = c; return wrong; },
      set: () => wrong,
      send: () => { blocked.set = true; },
    };
    assert.strictEqual(
      authorizeMetrics({ get: (h) => (h === 'authorization' ? 'Bearer nope' : undefined) }, wrong),
      false,
    );
  });
});

test('authorizeMetrics accepts a valid Bearer / x-metrics-token', () => {
  withEnv({ NODE_ENV: 'production', METRICS_TOKEN: 'scraper-secret' }, () => {
    assert.strictEqual(
      authorizeMetrics({ get: (h) => (h === 'authorization' ? 'Bearer scraper-secret' : undefined) }, {}),
      true,
    );
    assert.strictEqual(
      authorizeMetrics({ get: (h) => (h === 'x-metrics-token' ? 'scraper-secret' : undefined) }, {}),
      true,
    );
  });
});

test('safeEqual is constant-time-safe (length mismatch returns false, equal returns true)', () => {
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abcd'), false);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
});
