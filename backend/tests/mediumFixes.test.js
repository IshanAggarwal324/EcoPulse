const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { issueCsrfToken, csrfProtection, CSRF_HEADER } = require('../middleware/csrf');
const { getTtlSeconds } = require('../services/analytics/summaryCache');
const { deriveOverall } = require('../services/healthService');

test('fetchWithTimeout aborts slow requests', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  try {
    await assert.rejects(
      () => fetchWithTimeout('http://example.test/slow', {}, 50),
      (error) => error.name === 'AbortError',
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('csrfProtection rejects mutating cookie-auth requests without header token', () => {
  let statusCode = 200;
  const req = {
    method: 'POST',
    path: '/nodes',
    baseUrl: '/api/v1',
    headers: {
      cookie: 'accessToken=abc; csrfToken=token-a',
    },
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    cookie() {},
  };

  csrfProtection(req, res, (error) => {
    assert.ok(error);
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'CSRF_INVALID');
  });
  assert.equal(statusCode, 200);
});

test('csrfProtection allows mutating requests with matching token', () => {
  let passed = false;
  const req = {
    method: 'PUT',
    path: '/auth/profile',
    baseUrl: '/api/v1',
    headers: {
      cookie: 'accessToken=abc; csrfToken=token-a',
      [CSRF_HEADER]: 'token-a',
    },
  };

  csrfProtection(req, {}, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test('issueCsrfToken sets a csrf cookie when missing', () => {
  let cookieName = null;
  const req = { headers: {} };
  const res = {
    cookie(name) {
      cookieName = name;
    },
  };

  issueCsrfToken(req, res, () => {});
  assert.equal(cookieName, 'csrfToken');
});

test('summary cache TTL is positive', () => {
  assert.ok(getTtlSeconds() > 0);
});

test('health deriveOverall marks critical dependency outage as down', () => {
  const overall = deriveOverall({
    mongodb: { status: 'down' },
    backend: { status: 'up' },
    aiService: { status: 'up' },
  });
  assert.equal(overall, 'down');
});
