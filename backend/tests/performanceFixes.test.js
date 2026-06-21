const { test } = require('node:test');
const assert = require('node:assert');

const listingCache = require('../services/listingCache');

test('listingCache dedupes fetches within TTL', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return [{ id: 1, seller: '0xabc' }];
  };

  const first = await listingCache.getCachedActiveListings(fetchFn);
  const second = await listingCache.getCachedActiveListings(fetchFn);

  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(first, second);
});

test('listingCache refetches after invalidate', async () => {
  await listingCache.invalidateActiveListingsCache();
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return [{ id: calls }];
  };

  await listingCache.getCachedActiveListings(fetchFn);
  await listingCache.invalidateActiveListingsCache();
  const next = await listingCache.getCachedActiveListings(fetchFn);

  assert.strictEqual(calls, 2);
  assert.strictEqual(next[0].id, 2);
});

test('listingCache TTL helper is positive', () => {
  assert.ok(listingCache.getTtlSeconds() > 0);
});
