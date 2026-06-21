const MAX_KEYS = parseInt(process.env.RATE_LIMIT_MEMORY_MAX_KEYS || '10000', 10);
const CLEANUP_INTERVAL_MS = parseInt(process.env.RATE_LIMIT_MEMORY_CLEANUP_MS || '60000', 10);

let warnedProductionFallback = false;

const warnProductionFallback = () => {
  if (warnedProductionFallback || process.env.NODE_ENV !== 'production') return;
  warnedProductionFallback = true;
  console.warn(
    '[rateLimit] Redis unavailable — using in-memory fallback (limits are per-process, not cluster-wide)',
  );
};

/**
 * Bounded in-memory counter store used when Redis is down (H3 mitigation).
 */
function createMemoryStore(windowMs) {
  const hits = new Map();

  const cleanup = () => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.resetTime > windowMs) {
        hits.delete(key);
      }
    }

    if (hits.size <= MAX_KEYS) return;

    const overflow = hits.size - MAX_KEYS;
    const oldest = [...hits.entries()]
      .sort((a, b) => a[1].resetTime - b[1].resetTime)
      .slice(0, overflow);

    for (const [key] of oldest) {
      hits.delete(key);
    }
  };

  const interval = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return {
    increment(key) {
      warnProductionFallback();
      const now = Date.now();
      let entry = hits.get(key);

      if (!entry || now - entry.resetTime > windowMs) {
        entry = { count: 0, resetTime: now };
        hits.set(key, entry);
      }

      entry.count += 1;

      if (hits.size > MAX_KEYS) {
        cleanup();
      }

      return entry.count;
    },
  };
}

module.exports = {
  createMemoryStore,
  MAX_KEYS,
};
