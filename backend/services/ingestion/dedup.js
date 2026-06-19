const { getRedisClient, isRedisAvailable } = require('../../config/redis');

/**
 * Idempotency / dedup for telemetry (Sub-module 1.2.3).
 *
 * Requires a `messageId` (UUID) per device message. Uses Redis SETNX with a
 * 24h TTL as the fast, multi-instance-safe path, and falls back to an in-memory
 * LRU-ish Map when Redis is unavailable so dedup still works in dev.
 *
 * Key shape: `telemetry:dedup:{scopeId}:{messageId}`
 * where scopeId is the device deviceId (or providerKey for public_api).
 */

const DEDUP_TTL_SECONDS = parseInt(process.env.TELEMETRY_DEDUP_TTL_SECONDS || '86400', 10);
const MEMORY_MAX = 50000;
const DEDUP_PREFIX = 'telemetry:dedup';

const memorySeen = new Map();

const memoryKey = (scopeId, messageId) => `${scopeId}:${messageId}`;

/**
 * Returns `{ duplicate: boolean }`. When not a duplicate, marks messageId as
 * seen for scopeId.
 */
const checkAndMark = async ({ scopeId, messageId }) => {
  if (!scopeId || !messageId) {
    // Without an id we cannot dedup — treat as non-duplicate but callers should
    // require messageId for device/public_api paths.
    return { duplicate: false };
  }

  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    const key = `${DEDUP_PREFIX}:${scopeId}:${messageId}`;
    try {
      // NX = only set if not exists. Returns 'OK' on success, null if exists.
      const result = await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      return { duplicate: result !== 'OK' };
    } catch {
      /* fall through to memory */
    }
  }

  // In-memory fallback.
  const key = memoryKey(scopeId, messageId);
  const now = Date.now();
  // Lazy prune of expired entries.
  if (memorySeen.size > MEMORY_MAX) {
    for (const [k, ts] of memorySeen) {
      if (now - ts > DEDUP_TTL_SECONDS * 1000) memorySeen.delete(k);
    }
  }
  if (memorySeen.has(key)) {
    return { duplicate: true };
  }
  memorySeen.set(key, now);
  return { duplicate: false };
};

const clear = () => memorySeen.clear();

module.exports = { checkAndMark, clear, DEDUP_TTL_SECONDS };
