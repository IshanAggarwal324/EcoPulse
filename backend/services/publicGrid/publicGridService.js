const mongoose = require('mongoose');
const PublicGridSource = require('../../models/PublicGridSource');
const EnergyReading = require('../../models/EnergyReading');
const readingService = require('../readingService');
const ingestionMetrics = require('../ingestion/ingestionMetrics');
const auditService = require('../auditService');
const { safeFetch } = require('./httpClient');
const { getAdapter, validateProviderConfig } = require('./adapters/registry');
const config = require('../../config/publicGrid');
const { getRedisClient, isRedisAvailable } = require('../../config/redis');

/**
 * Public grid ingestion service (Sub-modules 1.5.3, 1.5.4, 1.5.5, 1.5.7).
 *
 * Orchestrates polling of open grid APIs:
 *   1. resolve the adapter for a source's providerKey
 *   2. gate on the feature flag + circuit breaker
 *   3. read the API key from process.env by NAME (never from the DB)
 *   4. fetch via the SSRF-guarded client bound to the adapter's host allowlist
 *   5. dedup (Redis SETNX fast path, DB-existence durable fallback)
 *   6. route through the unified `ingestReading()` as `source: 'public_api'`
 *
 * Security: the service never logs API keys, never builds a URL from a stored
 * field (the adapter does), and persists breaker state so a restart can't reset
 * the defense against a flapping provider.
 */

const SAFE_FIELDS = [
  'displayName',
  'attribution',
  'enabled',
  'pollIntervalMs',
  'nodeId',
  'apiKeyEnvVar',
  'maxCapacityMw',
];

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

// Resolve the provider API key from process.env. `apiKeyEnvVar` is the NAME of
// the env var only. The secret never leaves this function and is never logged.
const resolveApiKey = (adapter) => {
  if (!adapter?.requiresApiKey) return null;
  const envName = adapter.apiKeyEnvVar;
  if (!envName) return null;
  return process.env[envName] || null;
};

const isApiKeyConfigured = (adapter) => {
  if (!adapter?.requiresApiKey) return true;
  return Boolean(resolveApiKey(adapter));
};

/* ------------------------------------------------------------------ */
/* Dedup (1.5.7)                                                       */
/* ------------------------------------------------------------------ */

// Redis fast path with a durable DB-existence fallback so dedup still holds
// across restarts / when Redis is absent (acceptable at poller cadence).
const checkAndMarkDedup = async ({ source, reading }) => {
  const key = `${config.DEDUP_PREFIX}:${source.providerKey}:${reading.externalReadingId}`;
  const ttl = config.getDedupTtlSeconds();

  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      const result = await redis.set(key, '1', 'EX', ttl, 'NX');
      return { duplicate: result !== 'OK' };
    } catch {
      /* fall through to DB check */
    }
  }

  // Durable fallback: has this externalReadingId been stored already?
  const exists = await EnergyReading.exists({
    providerKey: source.providerKey,
    externalReadingId: reading.externalReadingId,
  });
  return { duplicate: Boolean(exists) };
};

/* ------------------------------------------------------------------ */
/* Circuit breaker (1.5.7)                                             */
/* ------------------------------------------------------------------ */

// Promote an 'open' breaker to 'half_open' once the cooldown has elapsed so a
// single probe poll is allowed (auto-recovery). No-op otherwise.
const maybeHalfOpen = (source) => {
  if (source.circuitState !== 'open') return source;
  if (!source.circuitOpenedAt) return source;
  if (Date.now() - source.circuitOpenedAt.getTime() < config.getCbCooldownMs()) return source;
  source.circuitState = 'half_open';
  return source;
};

const shouldSkipForCircuit = (source, { manual }) => {
  if (manual) return false; // an admin poll-now bypasses the breaker intentionally
  maybeHalfOpen(source);
  return source.circuitState === 'open';
};

const recordSuccess = (source) => {
  source.consecutiveFailures = 0;
  source.circuitState = 'closed';
  source.circuitOpenedAt = null;
  source.circuitTrippedReason = null;
  source.lastSuccessAt = new Date();
};

const recordFailure = async (source, reason, { actor, req } = {}) => {
  source.consecutiveFailures = (source.consecutiveFailures || 0) + 1;
  source.lastError = String(reason).slice(0, 255);

  const threshold = config.getCbFailureThreshold();
  if (source.consecutiveFailures >= threshold && source.circuitState !== 'open') {
    source.circuitState = 'open';
    source.circuitOpenedAt = new Date();
    source.circuitTrippedReason = source.lastError;

    // Audit the trip so operators see it in the dashboard/alerts.
    auditService
      .log({
        actor: actor || null,
        action: 'PUBLIC_GRID_CIRCUIT_TRIPPED',
        resourceType: 'public_grid',
        resourceId: source.providerKey,
        metadata: {
          providerKey: source.providerKey,
          consecutiveFailures: source.consecutiveFailures,
          cooldownMs: config.getCbCooldownMs(),
          reason: source.lastError,
        },
        req,
        severity: 'warn',
      })
      .catch(() => {});
  }
};

/* ------------------------------------------------------------------ */
/* Poll                                                                */
/* ------------------------------------------------------------------ */

/**
 * Poll one source. Resolves to a structured result; never throws — callers
 * (worker / admin) rely on `{ ok }`.
 *
 * @param {object} opts
 * @param {string} opts.sourceId  PublicGridSource _id
 * @param {boolean} [opts.manual] true for admin poll-now (bypasses breaker)
 * @param {object}  [opts.actor]  user for audit (admin poll-now)
 * @param {object}  [opts.req]    express req for audit
 */
const pollSource = async ({ sourceId, manual = false, actor = null, req = null }) => {
  if (!mongoose.Types.ObjectId.isValid(sourceId)) {
    return { ok: false, code: 'INVALID_SOURCE_ID', message: 'sourceId is not a valid id' };
  }

  const source = await PublicGridSource.findById(sourceId).exec();
  if (!source) return { ok: false, code: 'NOT_FOUND', message: 'source not found' };

  if (!manual && !config.isPublicApiAllowed()) {
    return { ok: false, code: 'DISABLED', message: 'public grid ingestion is disabled' };
  }

  if (shouldSkipForCircuit(source, { manual })) {
    return {
      ok: false,
      code: 'CIRCUIT_OPEN',
      message: `breaker open until cooldown (${source.circuitTrippedReason || 'failures'})`,
      circuitState: source.circuitState,
    };
  }

  const adapter = getAdapter(source.providerKey);
  if (!adapter) {
    await persistFailure(source, `unknown provider ${source.providerKey}`, { actor, req });
    return { ok: false, code: 'UNKNOWN_PROVIDER', message: 'no adapter registered' };
  }

  // API-key gate: if a key is required but not configured, fail (don't poll
  // anonymously and get 401s that burn the breaker on every tick).
  const apiKey = resolveApiKey(adapter);
  if (adapter.requiresApiKey && !apiKey) {
    await persistFailure(source, `API key not configured (${adapter.apiKeyEnvVar})`, {
      actor,
      req,
    });
    return {
      ok: false,
      code: 'API_KEY_MISSING',
      message: `required env var ${adapter.apiKeyEnvVar} is not set`,
    };
  }

  // Bound fetch bound to this adapter's host allowlist (SSRF guard).
  const boundFetch = (url, options = {}) =>
    safeFetch(url, { allowedHosts: adapter.hosts, ...options });

  const startedAt = Date.now();
  source.lastPollAt = new Date();
  source.lastError = null;

  try {
    const { readings } = await adapter.fetchLatest({
      config: source.config || {},
      apiKey,
      fetch: boundFetch,
    });

    if (!Array.isArray(readings) || readings.length === 0) {
      throw new Error('adapter returned no readings');
    }

    let accepted = 0;
    let duplicate = 0;
    let rejected = 0;
    const ceiling =
      typeof source.maxCapacityMw === 'number' && source.maxCapacityMw > 0
        ? source.maxCapacityMw
        : config.getDefaultMaxCapacityMw();
    const lastTs = [];

    for (const reading of readings) {
      // Re-validate against the source ceiling (defense in depth — the adapter
      // already ran normalizeReading, but a per-source cap can be tighter).
      const peak = Math.max(reading.energyGenerated, reading.energyConsumed);
      if (peak > ceiling) {
        rejected += 1;
        await deadLetter(source, 'out_of_range', `value ${peak} exceeds ceiling ${ceiling} MW`, reading);
        continue;
      }

      const { duplicate: dup } = await checkAndMarkDedup({ source, reading });
      if (dup) {
        duplicate += 1;
        ingestionMetrics.recordDuplicate();
        continue;
      }

      try {
        await readingService.ingestReading({
          source: 'public_api',
          nodeId: String(source.nodeId),
          energyGenerated: reading.energyGenerated,
          energyConsumed: reading.energyConsumed,
          timestamp: reading.timestamp,
          meta: {
            providerKey: source.providerKey,
            externalReadingId: reading.externalReadingId,
            unit: reading.unit || 'MW',
          },
        });
        ingestionMetrics.recordAccepted({
          source: 'public_api',
          transport: 'poller',
          providerKey: source.providerKey,
        });
        accepted += 1;
        if (reading.timestamp) lastTs.push(new Date(reading.timestamp));
      } catch (err) {
        rejected += 1;
        await deadLetter(source, 'ingest_error', err.message, reading);
      }
    }

    source.lastPollLatencyMs = Date.now() - startedAt;
    if (accepted > 0) {
      recordSuccess(source);
      if (lastTs.length) {
        source.lastReadingTimestamp = lastTs.reduce((max, t) => (t > max ? t : max));
      }
    } else if (duplicate > 0) {
      // All duplicates = the provider is fine, data just hasn't advanced. Treat
      // as a soft success so a stable-but-not-updating source doesn't trip.
      source.lastPollLatencyMs = Date.now() - startedAt;
      recordSuccess(source);
    } else {
      // No accepted, no duplicates, all rejected -> real failure.
      await persistFailure(source, 'all readings rejected', { actor, req, latencyMs: Date.now() - startedAt });
      return {
        ok: false,
        code: 'ALL_REJECTED',
        message: 'all readings rejected',
        accepted,
        duplicate,
        rejected,
      };
    }

    await source.save();

    return {
      ok: true,
      providerKey: source.providerKey,
      accepted,
      duplicate,
      rejected,
      latencyMs: source.lastPollLatencyMs,
    };
  } catch (err) {
    await persistFailure(source, err.message, { actor, req, latencyMs: Date.now() - startedAt });
    return {
      ok: false,
      code: 'FETCH_FAILED',
      message: String(err.message || err).slice(0, 200),
    };
  }
};

// Helper: persist a failure outcome (breaker + lastError + save) without throwing.
const persistFailure = async (source, reason, { actor, req, latencyMs } = {}) => {
  try {
    source.lastPollLatencyMs = typeof latencyMs === 'number' ? latencyMs : source.lastPollLatencyMs;
    await recordFailure(source, reason, { actor, req });
    await source.save();
  } catch (saveErr) {
    console.error('[publicGrid] failed to persist failure state:', saveErr.message);
  }
};

const deadLetter = async (source, kind, reason, reading) => {
  try {
    await ingestionMetrics.recordRejection({
      kind,
      source: 'poller',
      providerKey: source.providerKey,
      nodeId: source.nodeId,
      messageId: reading?.externalReadingId,
      reason,
      payload: reading,
    });
  } catch {
    /* observability must not break ingestion */
  }
};

/* ------------------------------------------------------------------ */
/* Poller status (for the admin dashboard)                             */
/* ------------------------------------------------------------------ */

let pollerStatusProvider = null;

const setPollerStatusProvider = (fn) => {
  pollerStatusProvider = typeof fn === 'function' ? fn : null;
};

// Shape expected by adminIngestionController.getIngestionDashboard.
const getPollerStatus = () => {
  if (typeof pollerStatusProvider === 'function') {
    try {
      return pollerStatusProvider();
    } catch {
      return { available: true, running: false };
    }
  }
  return { available: true, running: false };
};

/* ------------------------------------------------------------------ */
/* CRUD (used by the admin controller)                                 */
/* ------------------------------------------------------------------ */

const buildListFilter = (query = {}) => {
  const filter = {};
  if (query.providerKey) filter.providerKey = query.providerKey;
  if (typeof query.enabled === 'string') filter.enabled = query.enabled === 'true';
  if (query.circuitState) filter.circuitState = query.circuitState;
  return filter;
};

const createSource = async ({ providerKey, displayName, nodeId, enabled, pollIntervalMs, config: providerConfig, apiKeyEnvVar, attribution, maxCapacityMw, createdBy }) => {
  if (!getAdapter(providerKey)) {
    const err = new Error(`Unknown providerKey: ${providerKey}`);
    err.statusCode = 400;
    throw err;
  }

  const validation = validateProviderConfig(providerKey, providerConfig);
  if (!validation.ok) {
    const err = new Error(validation.message);
    err.statusCode = 400;
    throw err;
  }

  // For keyless providers, ignore any apiKeyEnvVar they try to set; for keyed
  // providers, default it to the adapter's canonical env-var name.
  const adapter = getAdapter(providerKey);
  const resolvedApiKeyEnvVar = adapter.requiresApiKey
    ? (apiKeyEnvVar || adapter.apiKeyEnvVar)
    : null;

  const source = await PublicGridSource.create({
    providerKey,
    displayName: displayName || adapter.displayName,
    attribution: attribution || adapter.attribution,
    enabled: Boolean(enabled),
    pollIntervalMs,
    nodeId,
    config: validation.normalized,
    apiKeyEnvVar: resolvedApiKeyEnvVar,
    maxCapacityMw,
    createdBy: createdBy || null,
  });

  return source;
};

module.exports = {
  pollSource,
  createSource,
  buildListFilter,
  resolveApiKey,
  isApiKeyConfigured,
  checkAndMarkDedup,
  maybeHalfOpen,
  shouldSkipForCircuit,
  recordSuccess,
  recordFailure,
  getPollerStatus,
  setPollerStatusProvider,
  SAFE_FIELDS,
};
