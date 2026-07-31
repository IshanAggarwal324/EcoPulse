/**
 * Regression tests for the fixes applied from
 * docs/audits/vercel-deployment-audit-2026-07-30.md
 *
 *  #2  blockchain sync reports WHY it is degraded (syncReason)
 *  #7  cold-start aware HTTP health probe
 *  #10 CSRF exemption list is anchored, not substring-matched
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isCsrfExempt } = require('../middleware/csrf');
const { projectSafeDetails, probeHttpService } = require('../services/healthService');

/* ------------------------------------------------------------------ */
/* #10 — CSRF exemption matching                                       */
/* ------------------------------------------------------------------ */

const req = (baseUrl, path) => ({ baseUrl, path });

test('CSRF exempt list still matches the real pre-session endpoints', () => {
  assert.equal(isCsrfExempt(req('/api/v1', '/auth/login')), true);
  assert.equal(isCsrfExempt(req('/api/v1', '/auth/register')), true);
  assert.equal(isCsrfExempt(req('/api/v1', '/auth/refresh')), true);
  assert.equal(isCsrfExempt(req('/api/v1', '/auth/captcha-config')), true);
  // Telemetry ingestion is exempt for the whole sub-tree.
  assert.equal(isCsrfExempt(req('/api/v1', '/telemetry')), true);
  assert.equal(isCsrfExempt(req('/api/v1', '/telemetry/')), true);
  assert.equal(isCsrfExempt(req('/api/v1', '/telemetry/readings')), true);
});

test('CSRF exemptions no longer leak to routes that merely CONTAIN an exempt string', () => {
  // The latent trap called out by the audit: substring matching handed these
  // routes a free pass.
  assert.equal(isCsrfExempt(req('/api/v1', '/admin/telemetry-settings')), false);
  assert.equal(isCsrfExempt(req('/api/v1', '/admin/device-telemetry')), false);
  assert.equal(isCsrfExempt(req('/api/v1', '/auth/login-history')), false);
  assert.equal(isCsrfExempt(req('/api/v1', '/auth/register-admin')), false);
  assert.equal(isCsrfExempt(req('/api/v1', '/auth/refresh-tokens')), false);
  assert.equal(isCsrfExempt(req('/api/v1', '/settings/telemetry-export')), false);
  // Unrelated mutating routes stay protected.
  assert.equal(isCsrfExempt(req('/api/v1', '/trades')), false);
  assert.equal(isCsrfExempt(req('/api/v1', '/admin/users')), false);
});

/* ------------------------------------------------------------------ */
/* #2 — blockchain sync reason                                         */
/* ------------------------------------------------------------------ */

test('deriveSyncReason distinguishes lagging, never_synced, stalled and ok', () => {
  const svc = require('../services/blockchainSyncService');
  const { SYNC_REASONS, deriveSyncReason, recordSyncSuccess, recordSyncFailure } = svc;

  recordSyncSuccess(); // fresh, successful run
  assert.equal(
    deriveSyncReason({ lastSyncedBlock: 100, syncLagBlocks: 3, lagThreshold: 50 }),
    SYNC_REASONS.OK,
  );
  assert.equal(
    deriveSyncReason({ lastSyncedBlock: 100, syncLagBlocks: 5000, lagThreshold: 50 }),
    SYNC_REASONS.LAGGING,
  );
  assert.equal(
    deriveSyncReason({ lastSyncedBlock: 0, syncLagBlocks: 0, lagThreshold: 50 }),
    SYNC_REASONS.NEVER_SYNCED,
  );

  // A failing background job that has not completed a recent run is `stalled`,
  // which is what the audit could not tell apart from plain lag.
  recordSyncFailure(new Error('exceeded compute units per second'));
  const health = svc.getSyncHealth();
  assert.equal(health.consecutiveFailures, 1);
  assert.match(health.lastFailureMessage, /compute units/);

  recordSyncSuccess(); // recover so the tracker is not left dirty
  assert.equal(svc.getSyncHealth().consecutiveFailures, 0);
});

test('public status whitelist exposes the coarse syncReason but nothing sensitive', () => {
  const details = projectSafeDetails('blockchain', {
    isSyncHealthy: false,
    syncReason: 'stalled',
    rpcHost: 'eth-sepolia.g.alchemy.com',
    blockNumber: 8123456,
    lastSyncedBlock: 8100000,
    syncHealth: { lastFailureMessage: 'boom' },
  });
  assert.deepEqual(details, { isSyncHealthy: false, syncReason: 'stalled' });
});

/* ------------------------------------------------------------------ */
/* #3 — disallowed CORS origin must be 403, not 500                    */
/* ------------------------------------------------------------------ */

const startCorsApp = async () => {
  const express = require('express');
  const cors = require('cors');
  const { buildCorsOptions } = require('../config/cors');
  const errorHandler = require('../middleware/errorHandler');

  const app = express();
  app.use(cors(buildCorsOptions({ isProduction: true })));
  app.get('/probe', (req, res) => res.status(200).json({ ok: true }));
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, port: server.address().port };
};

test('a disallowed CORS origin is refused with 403 CORS_BLOCKED (not a fake 500)', async () => {
  const originalOrigin = process.env.CORS_ORIGIN;
  const originalEnv = process.env.NODE_ENV;
  process.env.CORS_ORIGIN = 'https://eco-pulse-front.vercel.app';
  // errorHandler rewrites any 5xx to a generic 500 in production, so this also
  // proves the rejection is classified as a client error before that happens.
  process.env.NODE_ENV = 'production';

  const { server, port } = await startCorsApp();
  try {
    const blocked = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(blocked.status, 403);
    const body = await blocked.json();
    assert.equal(body.code, 'CORS_BLOCKED');
    assert.equal(body.success, false);

    // The allow-listed origin and origin-less callers are unaffected.
    const allowed = await fetch(`http://127.0.0.1:${port}/probe`, {
      headers: { Origin: 'https://eco-pulse-front.vercel.app' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'https://eco-pulse-front.vercel.app',
    );

    const noOrigin = await fetch(`http://127.0.0.1:${port}/probe`);
    assert.equal(noOrigin.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalOrigin;
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

/* ------------------------------------------------------------------ */
/* #7 — cold-start aware probe                                         */
/* ------------------------------------------------------------------ */

test('probeHttpService retries a timed-out probe and reports degraded + coldStart', async () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.HEALTH_PROBE_TIMEOUT_MS;
  const originalCold = process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS;
  process.env.HEALTH_PROBE_TIMEOUT_MS = '60';
  process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS = '2000';

  let calls = 0;
  global.fetch = (url, options) =>
    new Promise((resolve, reject) => {
      calls += 1;
      if (calls === 1) {
        // Simulate a suspended instance: never responds, so the probe aborts.
        options.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
        return;
      }
      resolve({
        status: 200,
        ok: true,
        json: async () => ({ status: 'ok', available: true }),
      });
    });

  try {
    const probe = await probeHttpService('https://genai.example', { label: 'genai-service' });
    assert.equal(calls, 2, 'expected exactly one cold-start retry');
    assert.equal(probe.status, 'degraded'); // alive but slow — NOT down
    assert.equal(probe.details.coldStart, true);
    assert.equal(probe.details.available, true);
  } finally {
    global.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.HEALTH_PROBE_TIMEOUT_MS;
    else process.env.HEALTH_PROBE_TIMEOUT_MS = originalTimeout;
    if (originalCold === undefined) delete process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS;
    else process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS = originalCold;
  }
});

test('probeHttpService still reports down when the cold-start retry also times out', async () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.HEALTH_PROBE_TIMEOUT_MS;
  const originalCold = process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS;
  process.env.HEALTH_PROBE_TIMEOUT_MS = '40';
  process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS = '60';

  global.fetch = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  try {
    const probe = await probeHttpService('https://dead.example', { label: 'ai_service' });
    assert.equal(probe.status, 'down');
    assert.match(probe.error, /cold-start retry/);
  } finally {
    global.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.HEALTH_PROBE_TIMEOUT_MS;
    else process.env.HEALTH_PROBE_TIMEOUT_MS = originalTimeout;
    if (originalCold === undefined) delete process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS;
    else process.env.HEALTH_PROBE_COLD_START_TIMEOUT_MS = originalCold;
  }
});

test('probeHttpService leaves a healthy service reporting up with coldStart false', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ status: 'ok', model_loaded: true }),
  });
  try {
    const probe = await probeHttpService('https://ai.example', { label: 'ai_service' });
    assert.equal(probe.status, 'up');
    assert.equal(probe.details.coldStart, false);
    assert.equal(probe.error, null);
  } finally {
    global.fetch = originalFetch;
  }
});
