const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const notFound = require('../middleware/notFound');
const errorHandler = require('../middleware/errorHandler');

const startApp = async () => {
  const app = express();
  app.get('/known', (req, res) => res.json({ ok: true }));
  app.get('/boom', (req, res, next) => next(new Error('real failure')));
  app.use(notFound);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

const withEnv = async (nodeEnv, fn) => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  const origError = console.error;
  console.error = () => {}; // errorHandler logs every error; keep test output clean
  try {
    await fn();
  } finally {
    console.error = origError;
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
};

for (const nodeEnv of ['production', 'development']) {
  test(`unknown route returns 404 NOT_FOUND, not a 500 (${nodeEnv})`, async () => {
    await withEnv(nodeEnv, async () => {
      const { server, base } = await startApp();
      try {
        const res = await fetch(`${base}/does-not-exist`);
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.code, 'NOT_FOUND');
        assert.match(body.message, /Not Found/);

        const nested = await fetch(`${base}/api/v1/health`);
        assert.equal(nested.status, 404);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
}

test('matched routes and genuine failures are unaffected by the 404 handler', async () => {
  await withEnv('production', async () => {
    const { server, base } = await startApp();
    try {
      const ok = await fetch(`${base}/known`);
      assert.equal(ok.status, 200);

      // A real handler error must still be a 500 (and stay generic in production).
      const boom = await fetch(`${base}/boom`);
      assert.equal(boom.status, 500);
      const body = await boom.json();
      assert.equal(body.code, 'INTERNAL_ERROR');
      assert.equal(body.message, 'Internal server error');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
