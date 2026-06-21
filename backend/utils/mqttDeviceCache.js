/**
 * TTL cache for MQTT device + node resolution (H23).
 *
 * Avoids two Mongo lookups per message when devices publish at high frequency.
 * Negative lookups (unknown nodeId) are cached too so misconfigured topics
 * cannot hammer the database.
 */

const TTL_MS = parseInt(process.env.MQTT_DEVICE_CACHE_TTL_MS || '60000', 10);
const MAX_ENTRIES = parseInt(process.env.MQTT_DEVICE_CACHE_MAX || '5000', 10);

const cache = new Map();

const prune = () => {
  if (cache.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
    if (cache.size <= MAX_ENTRIES) break;
  }
  if (cache.size <= MAX_ENTRIES) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of sorted.slice(0, sorted.length - MAX_ENTRIES)) {
    cache.delete(key);
  }
};

const get = (nodeId) => {
  const key = String(nodeId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return { device: entry.device, node: entry.node };
};

const set = (nodeId, { device, node }) => {
  cache.set(String(nodeId), {
    device: device || null,
    node: node || null,
    expiresAt: Date.now() + TTL_MS,
  });
  prune();
};

const invalidate = (nodeId) => {
  cache.delete(String(nodeId));
};

const clear = () => {
  cache.clear();
};

const size = () => cache.size;

module.exports = {
  get,
  set,
  invalidate,
  clear,
  size,
  TTL_MS,
  MAX_ENTRIES,
};
