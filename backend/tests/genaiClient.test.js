const { test } = require('node:test');
const assert = require('node:assert/strict');

const { postNarrate, fetchDocChunks, reindexAssistantDocs, postChat } = require('../services/genaiClient');

/**
 * Property 4: Preservation — postNarrate(), fetchDocChunks(), and
 * reindexAssistantDocs() must keep scheduling their abort timer at the
 * shared UPSTREAM_FETCH_TIMEOUT_MS default (20000ms), unaffected by any
 * chat-specific timeout change. Observed on UNFIXED code first (task 5);
 * these must continue to pass after task 6.3's fix.
 *
 * Technique: spy on global.setTimeout (used internally by fetchWithTimeout's
 * AbortController wiring) and capture the `ms` argument passed at call time,
 * following the outbound-call-spy pattern in outboundLogging.test.js.
 */
async function captureSetTimeoutMs(asyncFn) {
  const original = global.setTimeout;
  const calls = [];
  global.setTimeout = (cb, ms, ...args) => {
    calls.push(ms);
    return original(cb, ms, ...args);
  };
  try {
    await asyncFn();
  } finally {
    global.setTimeout = original;
  }
  return calls;
}

const okResponse = (body = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('postNarrate schedules the default UPSTREAM_FETCH_TIMEOUT_MS (20000ms) abort timer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => okResponse({ summary: 'ok', highlights: ['a'], disclaimer: 'demo' });
  try {
    const calls = await captureSetTimeoutMs(() =>
      postNarrate({ totalConsumed: 10 }, { period: '7d' }),
    );
    assert.ok(calls.includes(20000), `expected a 20000ms timer, got: ${calls.join(', ')}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchDocChunks schedules the default UPSTREAM_FETCH_TIMEOUT_MS (20000ms) abort timer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => okResponse({ chunks: [] });
  try {
    const calls = await captureSetTimeoutMs(() => fetchDocChunks('what is carbon credit', 3));
    assert.ok(calls.includes(20000), `expected a 20000ms timer, got: ${calls.join(', ')}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('reindexAssistantDocs schedules the default UPSTREAM_FETCH_TIMEOUT_MS (20000ms) abort timer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => okResponse({ reindexed: true });
  try {
    const calls = await captureSetTimeoutMs(() => reindexAssistantDocs());
    assert.ok(calls.includes(20000), `expected a 20000ms timer, got: ${calls.join(', ')}`);
  } finally {
    global.fetch = originalFetch;
  }
});

/**
 * Task 7 unit test — postChat() forwards the chat-specific
 * CHAT_UPSTREAM_TIMEOUT_MS (12000ms) to fetchWithTimeout once task 6.3 is
 * implemented, distinct from postNarrate()/fetchDocChunks()/
 * reindexAssistantDocs() above, which keep the 20000ms shared default.
 */
test('postChat schedules the chat-specific CHAT_UPSTREAM_TIMEOUT_MS (12000ms) abort timer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => okResponse({ reply: 'hi', disclaimer: 'demo' });
  try {
    const calls = await captureSetTimeoutMs(() => postChat({ message: 'what is carbon credit' }));
    assert.ok(calls.includes(12000), `expected a 12000ms timer, got: ${calls.join(', ')}`);
    assert.ok(!calls.includes(20000), `postChat should not use the 20000ms shared default, got: ${calls.join(', ')}`);
  } finally {
    global.fetch = originalFetch;
  }
});
