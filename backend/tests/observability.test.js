const { test } = require('node:test');
const assert = require('node:assert');

const { logger, runWithContext, getCorrelationId, logBackgroundError } = require('../utils/logger');
const {
  sanitizeCorrelationId,
  resolveCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
} = require('../utils/correlation');
const { fetchWithTimeout, buildOutboundHeaders } = require('../utils/fetchWithTimeout');
const correlationIdMiddleware = require('../middleware/correlationId');
const { renderMetrics, recordHttpRequest, normalizeRoute } = require('../services/metrics/prometheus');
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
