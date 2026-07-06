/**
 * In-memory TTL cache for AI-forecast responses with a stale-while-error
 * window (Sub-module resilience).
 *
 * Why this exists: on Render free tier there is no internal service URL, so the
 * backend reaches the AI service over the public path, which can be throttled
 * (429) by a fronting layer (Cloudflare / Render ingress) or briefly unavailable
 * (cold start). Rather than hard-erroring the dashboard, we cache each
 * successful AI forecast for a short TTL and keep serving the last good response
 * for a bounded "stale" window while the AI layer recovers. This turns a
 * transient upstream 429/5xx/unreachable into a degraded-but-functional
 * dashboard (with a stale-data notice) instead of a red error.
 *
 * Cache is keyed by the request shape (days/horizon/modelScope/nodeId/useDummy),
 * process-local and bounded, so it never grows unbounded. Freshness windows are
 * env-tunable and default conservative.
 */

const DEFAULT_TTL_MS = parseInt(process.env.FORECAST_CACHE_TTL_MS || '300000', 10); // 5 min fresh
const DEFAULT_STALE_MS = parseInt(process.env.FORECAST_CACHE_STALE_MS || '1800000', 10); // +30 min stale
const MAX_ENTRIES = 200;

const store = new Map(); // key -> { value, expiresAt, staleUntil }

const now = () => Date.now();

const set = (key, value, { ttlMs = DEFAULT_TTL_MS, staleMs = DEFAULT_STALE_MS } = {}) => {
  const t = now();
  store.set(key, {
    value,
    expiresAt: t + ttlMs,
    staleUntil: t + ttlMs + staleMs,
  });

  // Bounded eviction: drop fully-expired entries when the store grows.
  if (store.size > MAX_ENTRIES) {
    for (const [k, entry] of store) {
      if (entry.staleUntil < t) store.delete(k);
    }
  }
};

/**
 * Returns `{ value, stale }` when a usable entry exists (fresh or within the
 * stale window), otherwise `null`. Stale entries are served only so callers can
 * fall back during upstream errors; callers decide whether to use them.
 */
const get = (key) => {
  const entry = store.get(key);
  if (!entry) return null;
  const t = now();
  if (t < entry.expiresAt) return { value: entry.value, stale: false };
  if (t < entry.staleUntil) return { value: entry.value, stale: true };
  store.delete(key);
  return null;
};

const clear = () => store.clear();

module.exports = { set, get, clear };
