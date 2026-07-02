const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scrubMessage } = require('../utils/scrubLog');

test('scrubMessage strips URLs with embedded keys', () => {
  const out = scrubMessage('failed https://eth.g.alchemy.com/v2/SECRETKEY123 path');
  assert.ok(!out.includes('SECRETKEY123'));
  assert.ok(!out.includes('https://'));
  assert.ok(out.includes('[url]') || out.includes('[host]'));
});

test('scrubMessage redacts IPv4 addresses and ports', () => {
  const out = scrubMessage('ECONNREFUSED 10.0.0.9:8001 timed out');
  assert.ok(!out.includes('10.0.0.9'));
  assert.ok(!out.includes('8001'));
  assert.ok(out.includes('ECONNREFUSED')); // category preserved
  assert.ok(out.includes('[addr]'));
});

test('scrubMessage redacts internal EcoPulse hostnames', () => {
  const out = scrubMessage('dial tcp genai-service:8001: connect: connection refused');
  assert.ok(!out.includes('genai-service'));
  assert.ok(out.includes('[host]'));
});

test('scrubMessage handles null/undefined safely', () => {
  assert.equal(scrubMessage(null), null);
  assert.equal(scrubMessage(undefined), null);
});

test('scrubMessage truncates very long strings', () => {
  assert.ok(scrubMessage('x'.repeat(1000)).length <= 240);
});
