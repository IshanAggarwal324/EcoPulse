const { test } = require('node:test');
const assert = require('node:assert');

const { logger, runWithContext, logBackgroundError } = require('../utils/logger');
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
