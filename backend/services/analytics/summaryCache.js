/**
 * Short TTL cache for dashboard summary payloads (M8).
 */
const { getRedisClient, isRedisAvailable } = require('../../config/redis');

const CACHE_PREFIX = 'analytics:summary:v1';

const getTtlSeconds = () => {
  const parsed = parseInt(process.env.SUMMARY_CACHE_TTL_SECONDS || '30', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
};

const buildCacheKey = (walletAddress, sinceHours) => {
  const wallet = walletAddress ? String(walletAddress).toLowerCase() : 'none';
  const hours = sinceHours != null ? String(sinceHours) : 'all';
  return `${CACHE_PREFIX}:${wallet}:${hours}`;
};

let memoryCache = new Map();

const isFresh = (at) => Date.now() - at < getTtlSeconds() * 1000;

const getCachedSummary = async (walletAddress, sinceHours, fetchFn) => {
  const key = buildCacheKey(walletAddress, sinceHours);
  const memHit = memoryCache.get(key);
  if (memHit && isFresh(memHit.at)) {
    return memHit.value;
  }

  if (isRedisAvailable()) {
    try {
      const raw = await getRedisClient().get(key);
      if (raw) {
        const value = JSON.parse(raw);
        memoryCache.set(key, { at: Date.now(), value });
        return value;
      }
    } catch {
      // fall through
    }
  }

  const value = await fetchFn();
  memoryCache.set(key, { at: Date.now(), value });

  if (isRedisAvailable()) {
    try {
      await getRedisClient().set(key, JSON.stringify(value), 'EX', getTtlSeconds());
    } catch {
      // best-effort
    }
  }

  return value;
};

const invalidateSummaryCache = async () => {
  memoryCache.clear();
  if (!isRedisAvailable()) return;
  try {
    const client = getRedisClient();
    const keys = await client.keys(`${CACHE_PREFIX}:*`);
    if (keys.length) await client.del(...keys);
  } catch {
    // ignore
  }
};

module.exports = {
  getCachedSummary,
  invalidateSummaryCache,
  getTtlSeconds,
};
