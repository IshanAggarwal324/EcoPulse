/**
 * Ingestion observability (Sub-module 1.2.7).
 *
 * Prometheus-style in-memory counters for accepted / rejected / duplicate
 * telemetry, plus per-device and per-provider last-seen tracking. Counters are
 * process-local (suitable for single-instance deployments and the admin
 * ingestion dashboard); for multi-instance, wire these to Redis in a follow-up.
 *
 * Also exposes a helper to record a dead-letter entry (IngestionError) and bump
 * the matching counter in one call.
 */

const IngestionError = require('../../models/IngestionError');
const { logger } = require('../../utils/logger');

const counters = {
  accepted: 0,
  rejected: 0,
  duplicate: 0,
  rejectedPersistSkipped: 0,
};

// Breakdown by reading source + by transport.
const bySource = { simulated: 0, device: 0, admin: 0, public_api: 0 };
const byTransport = { mqtt: 0, http: 0, internal: 0, poller: 0 };

// Per-device last-seen (deviceId -> { at, ip, count }).
const deviceSeen = new Map();
// Per-provider last-seen (providerKey -> { at, count }).
const providerSeen = new Map();

const DEVICE_SEEN_MAX = 5000;
const PROVIDER_SEEN_MAX = parseInt(process.env.INGESTION_PROVIDER_SEEN_MAX || '2000', 10);
const DEDUP_KEYS_MAX = parseInt(process.env.INGESTION_DEDUP_KEYS_MAX || '5000', 10);

const PERSIST_ENABLED = () =>
  String(process.env.INGESTION_ERROR_PERSIST || 'true').toLowerCase() !== 'false';
const getPersistMaxPerMinute = () => {
  const parsed = parseInt(process.env.INGESTION_ERROR_PERSIST_MAX || '120', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
};
const getDedupTtlMs = () => {
  const parsed = parseInt(process.env.INGESTION_ERROR_DEDUP_MS || '60000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
};

const persistTimestamps = [];
const dedupKeys = new Map();

const pruneDedupKeys = () => {
  const now = Date.now();
  for (const [key, expiresAt] of dedupKeys) {
    if (expiresAt <= now) dedupKeys.delete(key);
  }
  if (dedupKeys.size <= DEDUP_KEYS_MAX) return;
  const sorted = [...dedupKeys.entries()].sort((a, b) => a[1] - b[1]);
  for (const [key] of sorted.slice(0, dedupKeys.size - DEDUP_KEYS_MAX)) {
    dedupKeys.delete(key);
  }
};

const pruneProviderSeen = () => {
  if (providerSeen.size <= PROVIDER_SEEN_MAX) return;
  const sorted = [...providerSeen.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at));
  for (const [key] of sorted.slice(0, providerSeen.size - PROVIDER_SEEN_MAX)) {
    providerSeen.delete(key);
  }
};

const buildDedupKey = ({ kind, source, nodeId, reason }) =>
  `${kind}|${source || ''}|${nodeId || ''}|${String(reason || '').slice(0, 64)}`;

/**
 * Decide whether a rejection should be written to Mongo (H24).
 * Always increments in-memory counters; DB writes are deduped + rate-limited.
 */
const shouldPersistRejection = ({ kind, source, nodeId, reason }) => {
  if (!PERSIST_ENABLED()) return false;

  pruneDedupKeys();
  const dedupKey = buildDedupKey({ kind, source, nodeId, reason });
  const now = Date.now();
  const dedupExpiry = dedupKeys.get(dedupKey);
  if (dedupExpiry && dedupExpiry > now) return false;

  while (persistTimestamps.length && persistTimestamps[0] < now - 60_000) {
    persistTimestamps.shift();
  }
  const maxPerMinute = getPersistMaxPerMinute();
  if (persistTimestamps.length >= maxPerMinute) return false;

  dedupKeys.set(dedupKey, now + getDedupTtlMs());
  persistTimestamps.push(now);
  return true;
};

const pruneDeviceSeen = () => {
  if (deviceSeen.size <= DEVICE_SEEN_MAX) return;
  // Drop oldest entries when the map grows unbounded.
  const sorted = [...deviceSeen.entries()].sort((a, b) => a.value.at - b.value.at);
  const drop = sorted.slice(0, sorted.length - DEVICE_SEEN_MAX);
  for (const [key] of drop) deviceSeen.delete(key);
};

const recordAccepted = ({ source, transport = 'internal', deviceId, providerKey, ip } = {}) => {
  counters.accepted += 1;
  if (source && bySource[source] !== undefined) bySource[source] += 1;
  if (transport && byTransport[transport] !== undefined) byTransport[transport] += 1;

  if (deviceId) {
    deviceSeen.set(deviceId, {
      at: new Date().toISOString(),
      ip: ip || null,
      count: (deviceSeen.get(deviceId)?.count || 0) + 1,
    });
    pruneDeviceSeen();
  }
  if (providerKey) {
    providerSeen.set(providerKey, {
      at: new Date().toISOString(),
      count: (providerSeen.get(providerKey)?.count || 0) + 1,
    });
    pruneProviderSeen();
  }
};

const recordDuplicate = () => {
  counters.duplicate += 1;
};

/**
 * Record a rejection. Persists a dead-letter entry (capped payload) and bumps
 * the rejected counter. Never throws — observability must not break ingestion.
 */
const recordRejection = async ({
  kind = 'unknown',
  source,
  deviceId = null,
  nodeId = null,
  providerKey = null,
  messageId = null,
  reason = null,
  payload = null,
  ip = null,
}) => {
  counters.rejected += 1;

  if (!shouldPersistRejection({ kind, source, nodeId, reason })) {
    counters.rejectedPersistSkipped += 1;
    return;
  }

  try {
    // Cap payload size to avoid storing huge / abusive bodies.
    let safePayload = payload;
    if (safePayload !== null && safePayload !== undefined) {
      try {
        const json = JSON.stringify(safePayload);
        safePayload = json.length > 2048 ? { _truncated: true, preview: json.slice(0, 2048) } : safePayload;
      } catch {
        safePayload = { _unserializable: true };
      }
    }

    await IngestionError.create({
      kind: IngestionError.VALID_KINDS.includes(kind) ? kind : 'unknown',
      source,
      deviceId,
      nodeId,
      providerKey,
      messageId,
      reason: reason ? String(reason).slice(0, 255) : null,
      payload: safePayload,
      ip: ip || null,
    });
  } catch (err) {
    logger.warn('ingestion dead-letter persist failed', { err, kind, source, component: 'ingestion' });
  }
};

/**
 * Build a snapshot for the admin ingestion dashboard / health endpoint.
 */
const getSnapshot = () => ({
  counters: { ...counters },
  bySource: { ...bySource },
  byTransport: { ...byTransport },
  devicesSeen: deviceSeen.size,
  providersSeen: providerSeen.size,
  recentDevices: [...deviceSeen.entries()]
    .sort((a, b) => (b.value.at > a.value.at ? 1 : -1))
    .slice(0, 20)
    .map(([deviceId, info]) => ({ deviceId, ...info })),
  recentProviders: [...providerSeen.entries()]
    .sort((a, b) => (b.value.at > a.value.at ? 1 : -1))
    .slice(0, 20)
    .map(([providerKey, info]) => ({ providerKey, ...info })),
});

/**
 * Aggregate dead-letter counts from Mongo for the dashboard.
 */
const getErrorStats = async ({ sinceHours = 24 } = {}) => {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000);
  const [byKind, total] = await Promise.all([
    IngestionError.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$kind', count: { $sum: 1 } } },
    ]),
    IngestionError.countDocuments({ createdAt: { $gte: since } }),
  ]);

  return {
    sinceHours,
    total,
    byKind: byKind.reduce((acc, row) => {
      acc[row._id] = row.count;
      return acc;
    }, {}),
  };
};

const reset = () => {
  counters.accepted = 0;
  counters.rejected = 0;
  counters.duplicate = 0;
  counters.rejectedPersistSkipped = 0;
  Object.keys(bySource).forEach((k) => (bySource[k] = 0));
  Object.keys(byTransport).forEach((k) => (byTransport[k] = 0));
  deviceSeen.clear();
  providerSeen.clear();
  persistTimestamps.length = 0;
  dedupKeys.clear();
};

module.exports = {
  recordAccepted,
  recordDuplicate,
  recordRejection,
  getSnapshot,
  getErrorStats,
  reset,
  shouldPersistRejection,
  buildDedupKey,
};
