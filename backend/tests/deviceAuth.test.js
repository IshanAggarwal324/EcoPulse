const { test } = require('node:test');
const assert = require('node:assert');
const deviceService = require('../services/deviceService');

// Sub-module 1.1 — device key/lockout invariants that do not require Mongo/Redis.

test('generateApiKey produces an ek_-prefixed 256-bit hex key', () => {
  const key = deviceService.generateApiKey();
  assert.ok(key.startsWith(deviceService.API_KEY_PREFIX));
  // prefix + 64 hex chars
  assert.match(
    key,
    new RegExp(`^${deviceService.API_KEY_PREFIX}[a-f0-9]{64}$`),
  );
});

test('generateApiKey is not predictable across calls (entropy sanity)', () => {
  const keys = new Set();
  for (let i = 0; i < 1000; i += 1) keys.add(deviceService.generateApiKey());
  assert.strictEqual(keys.size, 1000, 'key generation must not collide');
});

test('generateDeviceId is dev_-prefixed and within the schema length bound', () => {
  const id = deviceService.generateDeviceId();
  assert.ok(id.startsWith(deviceService.DEVICE_ID_PREFIX));
  // 6..64 chars total per schema regex
  assert.ok(id.length >= 6 && id.length <= 64);
});

test('hashApiKey returns a bcrypt hash and verifyApiKey round-trips it', async () => {
  const plaintext = deviceService.generateApiKey();
  const hash = await deviceService.hashApiKey(plaintext);
  assert.ok(hash.startsWith('$2'));
  assert.ok(await deviceService.verifyApiKey(plaintext, hash));
  assert.ok(!(await deviceService.verifyApiKey('ek_wrong', hash)));
});

test('verifyApiKey rejects falsy inputs without throwing', async () => {
  assert.strictEqual(await deviceService.verifyApiKey(null, null), false);
  assert.strictEqual(await deviceService.verifyApiKey('x', ''), false);
  assert.strictEqual(await deviceService.verifyApiKey('', '$2a$12$abc'), false);
});

test('verifyApiKey returns false on a malformed stored hash (no crash)', async () => {
  assert.strictEqual(await deviceService.verifyApiKey('ek_abc', 'not-a-bcrypt-hash'), false);
});

test('telemetryTopicFor builds the canonical ACL topic for a node', () => {
  assert.strictEqual(
    deviceService.telemetryTopicFor('507f1f77bcf86cd799439011'),
    'ecopulse/nodes/507f1f77bcf86cd799439011/telemetry',
  );
});

test('defaultAllowedTopics returns exactly the telemetry topic (minimal ACL surface)', () => {
  const topics = deviceService.defaultAllowedTopics('node-1');
  assert.deepStrictEqual(topics, ['ecopulse/nodes/node-1/telemetry']);
  assert.strictEqual(topics.length, 1);
});

test('lockout constants are positive and sane', () => {
  assert.ok(deviceService.MAX_FAILED_ATTEMPTS > 0);
  assert.ok(deviceService.LOCKOUT_MS > 0);
});

test('isDeviceAuthEnabled defaults to false when env unset', () => {
  const original = process.env.DEVICE_AUTH_ENABLED;
  delete process.env.DEVICE_AUTH_ENABLED;
  assert.strictEqual(deviceService.isDeviceAuthEnabled(), false);
  process.env.DEVICE_AUTH_ENABLED = 'true';
  assert.strictEqual(deviceService.isDeviceAuthEnabled(), true);
  process.env.DEVICE_AUTH_ENABLED = 'TRUE';
  assert.strictEqual(deviceService.isDeviceAuthEnabled(), true);
  if (original === undefined) delete process.env.DEVICE_AUTH_ENABLED;
  else process.env.DEVICE_AUTH_ENABLED = original;
});
