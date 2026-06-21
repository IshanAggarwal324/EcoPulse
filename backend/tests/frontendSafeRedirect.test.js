const { test } = require('node:test');
const assert = require('node:assert');

// Mirrors frontend/utils/safeRedirect.js (ESM) for Node test runner compatibility.
const getSafeRedirectPath = (pathname, fallback = '/') => {
  if (typeof pathname !== 'string' || !pathname) return fallback;
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return fallback;
  if (pathname.includes('://') || pathname.includes('\\')) return fallback;
  return pathname;
};

test('getSafeRedirectPath allows in-app paths', () => {
  assert.strictEqual(getSafeRedirectPath('/dashboard'), '/dashboard');
  assert.strictEqual(getSafeRedirectPath('/nodes/abc'), '/nodes/abc');
});

test('getSafeRedirectPath blocks open redirects', () => {
  assert.strictEqual(getSafeRedirectPath('https://evil.example'), '/');
  assert.strictEqual(getSafeRedirectPath('//evil.example'), '/');
  assert.strictEqual(getSafeRedirectPath('/\\evil'), '/');
});

test('getSafeRedirectPath falls back for empty input', () => {
  assert.strictEqual(getSafeRedirectPath(''), '/');
  assert.strictEqual(getSafeRedirectPath(null, '/home'), '/home');
});
