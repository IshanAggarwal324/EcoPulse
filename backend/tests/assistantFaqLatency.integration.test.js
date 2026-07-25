const { test } = require('node:test');
const assert = require('node:assert/strict');

// Integration tests (task 8) for the fixed end-to-end flow spanning both root
// causes: Fix A (classifyIntent FAQ-priority gating) and Fix B (genai-service
// explanation-only short-circuit / bounded timeouts). These stitch together
// intentClassifier.js + retrievalService.js's carbon retriever, confirming
// the request is no longer routed to the wallet-gated retriever for
// FAQ-phrased questions, and that genuine data requests still get the
// existing wallet-gated explanation unchanged.

const { classifyIntent } = require('../services/intentClassifier');
const { retrieveForIntent } = require('../services/retrievalService');

test('end-to-end: "what is carbon credit" classifies as faq, NOT routed to the wallet-gated carbon retriever', async () => {
  const { intent } = classifyIntent('what is carbon credit');
  assert.strictEqual(intent, 'faq');

  // faq has no entry in INTENT_RETRIEVER_MAP, so retrieveForIntent must NOT
  // invoke retrieveCarbon()/its wallet-gated short-circuit for this intent.
  const { retrieved_data, sources } = await retrieveForIntent(intent, { walletAddress: null });
  assert.notStrictEqual(retrieved_data.explanation, 'No wallet connected. Carbon credit data is unavailable.');
  assert.deepStrictEqual(sources, []);
});

test('end-to-end: "show me my carbon credit balance" (genuine data request) still returns the unchanged wallet-gated explanation', async () => {
  const { intent } = classifyIntent('show me my carbon credit balance');
  assert.strictEqual(intent, 'carbon');

  const { retrieved_data, sources } = await retrieveForIntent(intent, { walletAddress: null });
  assert.strictEqual(retrieved_data.walletConnected, false);
  assert.strictEqual(
    retrieved_data.explanation,
    'No wallet connected. Carbon credit data is unavailable.',
  );
  assert.deepStrictEqual(sources, []);
});

test('end-to-end: FAQ-phrased questions across data-keyword collisions never hit a wallet-gated intent', async () => {
  const cases = [
    'what is carbon credit',
    'what are carbon credits?',
    'how does energy trading work?',
    'explain node status',
  ];
  for (const message of cases) {
    const { intent } = classifyIntent(message);
    assert.strictEqual(intent, 'faq', `expected faq for "${message}"`);
  }
});
