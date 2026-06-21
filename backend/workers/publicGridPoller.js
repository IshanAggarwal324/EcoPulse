const PublicGridSource = require('../models/PublicGridSource');
const publicGridService = require('../services/publicGrid/publicGridService');
const config = require('../config/publicGrid');

/**
 * Public grid poller worker (Sub-module 1.5.3).
 *
 * Started from server.js when `PUBLIC_GRID_INGESTION_ENABLED=true` (and public
 * APIs are an allowed ingestion source). Iterates enabled sources on a cadence,
 * polling each whose interval has elapsed. Per-source intervals are honored, so
 * a 15-min source and a 60-min source share one loop without over-polling.
 *
 * Design:
 *   - One loop tick (default every 60s) scans sources; each source is polled
 *     only when due. This is cheaper + gentler than one timer per source.
 *   - Small jitter between sources so a fleet of sources doesn't hammer a
 *     provider at the same wall-clock instant.
 *   - Sequential polling (not parallel) to be a good citizen toward free APIs
 *     and to keep the breaker/observability state simple.
 *   - Idempotent start; safe to call repeatedly.
 *   - The worker never holds secrets — polling reads keys from env via the
 *     service at poll time.
 */

const TICK_INTERVAL_MS = 60 * 1000; // scan cadence (per-source cadence is separate)

let timer = null;
let bootstrapTimer = null;
let scanning = false;
let lastScanAt = null;
let lastScanSummary = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isDue = (source) => {
  if (!source.lastPollAt) return true;
  const interval = source.pollIntervalMs || config.getDefaultPollInterval();
  return Date.now() - source.lastPollAt.getTime() >= interval;
};

/**
 * Find sources that should be polled now: enabled + due, plus any enabled
 * source currently in half_open (awaiting its single recovery probe).
 */
const findDueSources = async () => {
  const sources = await PublicGridSource.find({ enabled: true })
    .select('_id providerKey pollIntervalMs lastPollAt circuitState')
    .lean();

  // Promote breakers whose cooldown has elapsed so the probe runs this scan.
  return sources
    .filter((s) => s.circuitState === 'half_open' || isDue(s))
    .map((s) => s._id);
};

const scan = async () => {
  if (scanning) return;
  scanning = true;
  const polled = [];
  const failed = [];

  try {
    if (!config.isPublicApiAllowed()) {
      lastScanSummary = { ok: true, reason: 'disabled', polled: 0 };
      return;
    }

    const dueIds = await findDueSources();
    const jitter = config.getJitterMs();

    for (const sourceId of dueIds) {
      // Spread sources across a small jitter window.
      if (jitter > 0) await sleep(Math.floor(Math.random() * jitter));

      // eslint-disable-next-line no-await-in-loop
      const result = await publicGridService.pollSource({ sourceId });
      if (result.ok) {
        polled.push({ providerKey: result.providerKey, accepted: result.accepted });
      } else if (result.code !== 'CIRCUIT_OPEN' && result.code !== 'DISABLED') {
        failed.push({ code: result.code, message: result.message });
      }
    }

    lastScanAt = new Date();
    lastScanSummary = { ok: true, polled: polled.length, failed: failed.length };
  } catch (err) {
    console.error('[publicGridPoller] scan failed:', err.message);
    lastScanSummary = { ok: false, error: err.message };
  } finally {
    scanning = false;
  }
};

const start = () => {
  if (timer) return false;
  if (!config.isPublicApiAllowed()) {
    console.log('[publicGridPoller] not started (public grid ingestion disabled)');
    return false;
  }

  // Expose status to the admin dashboard without a circular import.
  publicGridService.setPollerStatusProvider(getStatus);

  // Stagger the first scan ~30s after boot so server.js wiring settles.
  bootstrapTimer = setTimeout(scan, 30 * 1000);
  timer = setInterval(scan, TICK_INTERVAL_MS);
  console.log(`[publicGridPoller] started (scan every ${TICK_INTERVAL_MS}ms)`);
  return true;
};

const stop = () => {
  if (bootstrapTimer) {
    clearTimeout(bootstrapTimer);
    bootstrapTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[publicGridPoller] stopped');
  }
};

const getStatus = () => ({
  available: true,
  enabled: config.isPublicGridEnabled(),
  publicApiAllowed: config.isPublicApiAllowed(),
  running: !!timer,
  scanning,
  tickIntervalMs: TICK_INTERVAL_MS,
  lastScanAt: lastScanAt ? lastScanAt.toISOString() : null,
  lastScanSummary,
});

module.exports = { start, stop, scan, findDueSources, isDue, getStatus, TICK_INTERVAL_MS };
