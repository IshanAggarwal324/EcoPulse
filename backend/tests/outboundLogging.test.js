const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendGenaiRequest, postChat } = require('../services/genaiClient');

// Capture JSON lines written to stdout by the structured logger.
const captureStdout = () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    restore: () => {
      process.stdout.write = original;
    },
  };
};

const findLog = (lines, predicate) =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .find(predicate);

const okResponse = (body = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('outbound genai request logs targetService (debug)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => okResponse({ reply: 'hi' });
  const cap = captureStdout();
  try {
    await postChat({ message: 'hello' });
  } finally {
    cap.restore();
    global.fetch = originalFetch;
  }

  const entry = findLog(cap.lines(), (e) => e.targetService === 'genai-service');
  assert.ok(entry, 'expected an outbound log with targetService');
  assert.equal(entry.targetService, 'genai-service');
  assert.equal(entry.path, '/assistant/chat');
  assert.equal(entry.method, 'POST');
  // Never log request bodies (chat content may contain PII).
  assert.equal(entry.message, undefined);
  assert.equal(entry.body, undefined);
});

test('genai error path logs targetService + status (warn)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({}),
    text: async () => 'Bad Gateway',
  });
  const cap = captureStdout();
  try {
    await assert.rejects(() => sendGenaiRequest(() => Promise.resolve({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => 'Bad Gateway',
    })));
  } finally {
    cap.restore();
    global.fetch = originalFetch;
  }

  const entry = findLog(
    cap.lines(),
    (e) => e.targetService === 'genai-service' && e.status === 502,
  );
  assert.ok(entry, 'expected a warn log with targetService + status');
  assert.equal(entry.level, 'warn');
});

test('genai network failure logs targetService (warn) without leaking internals', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('ECONNREFUSED 10.0.0.9:8001');
  };
  const cap = captureStdout();
  try {
    await assert.rejects(() => postChat({ message: 'x' }));
  } finally {
    cap.restore();
    global.fetch = originalFetch;
  }

  const entry = findLog(cap.lines(), (e) => e.targetService === 'genai-service' && e.level === 'warn');
  assert.ok(entry);
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes('10.0.0.9'), 'internal address leaked into outbound log');
});
