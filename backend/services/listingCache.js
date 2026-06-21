/**
 * Short-lived cache for active marketplace listings (H6).
 *
 * Avoids repeated O(n) on-chain scans when pricing, surplus detection, and
 * marketplace endpoints request the order book within the same TTL window.
 */

const { getRedisClient, isRedisAvailable } = require('../config/redis');

const CACHE_KEY = 'marketplace:active_listings:v1';
const getTtlSeconds = () => {
  const parsed = parseInt(process.env.LISTINGS_CACHE_TTL_SECONDS || '30', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
};

let memoryCache = { at: 0, listings: null };

const isFresh = (at) => Date.now() - at < getTtlSeconds() * 1000;

const getCachedActiveListings = async (fetchFn) => {
  if (memoryCache.listings && isFresh(memoryCache.at)) {
    return memoryCache.listings;
  }

  if (isRedisAvailable()) {
    try {
      const raw = await getRedisClient().get(CACHE_KEY);
      if (raw) {
        const listings = JSON.parse(raw);
        memoryCache = { at: Date.now(), listings };
        return listings;
      }
    } catch {
      // fall through to chain fetch
    }
  }

  const listings = await fetchFn();
  memoryCache = { at: Date.now(), listings };

  if (isRedisAvailable()) {
    try {
      await getRedisClient().set(CACHE_KEY, JSON.stringify(listings), 'EX', getTtlSeconds());
    } catch {
      // cache write is best-effort
    }
  }

  return listings;
};

const invalidateActiveListingsCache = async () => {
  memoryCache = { at: 0, listings: null };
  if (!isRedisAvailable()) return;
  try {
    await getRedisClient().del(CACHE_KEY);
  } catch {
    // ignore
  }
};

module.exports = {
  getCachedActiveListings,
  invalidateActiveListingsCache,
  getTtlSeconds,
};
