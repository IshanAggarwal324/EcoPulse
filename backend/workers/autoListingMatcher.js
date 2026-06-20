/**
 * Auto-listing matcher worker (Sub-module 2.3.3).
 *
 * Runs the autoTradingService.evaluateAll() loop on a cadence (default 15 min,
 * per the plan). Idempotent per (policyId, UTC hour) and fail-closed on the
 * kill switch (env flag + admin DB pause) or a Redis outage.
 *
 * Conventions: like the rollup / public-grid workers this uses a plain
 * `setInterval` loop with Redis-backed idempotency rather than introducing a
 * BullMQ dependency, matching the rest of the codebase.
 */

const autoTradingService = require('../services/pricing/autoTradingService');
const autoConfig = require('../config/autoTrading');

let timer = null;
let running = false;
let lastRunAt = null;
let lastRunSummary = null;

const tick = async () => {
  if (running) return;
  running = true;
  try {
    lastRunSummary = await autoTradingService.evaluateAll();
    lastRunAt = new Date();
  } catch (err) {
    console.error('[autoListingMatcher] tick failed:', err.message);
    lastRunSummary = { ok: false, error: err.message };
  } finally {
    running = false;
  }
};

/**
 * Start the matcher. Idempotent. Refuses to start unless the env flag is on;
 * once started, the per-tick kill-switch (env + admin pause) still gates each
 * evaluation, so a runtime admin pause takes effect on the next tick without a
 * restart.
 */
const start = () => {
  if (timer) return false;
  if (!autoConfig.isAutoTradingEnvEnabled()) {
    console.log('[autoListingMatcher] not started (AUTO_TRADING_ENABLED is false)');
    return false;
  }

  // Stagger the first run ~3 min after boot so server wiring settles and the
  // pricing cache / forecast service are warm.
  setTimeout(tick, 3 * 60 * 1000);
  const intervalMs = autoConfig.getMatcherIntervalMs();
  timer = setInterval(tick, intervalMs);
  console.log(`[autoListingMatcher] started (every ${intervalMs}ms, notify-only v1)`);
  return true;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[autoListingMatcher] stopped');
  }
};

const runOnce = async () => tick();

const getStatus = async () => {
  const killSwitch = await autoTradingService.getKillSwitchStatus().catch(() => ({
    envEnabled: autoConfig.isAutoTradingEnvEnabled(),
    active: false,
    paused: true,
  }));
  return {
    running: !!timer,
    busy: running,
    intervalMs: autoConfig.getMatcherIntervalMs(),
    algoVersion: autoConfig.AUTO_TRADING_ALGO_VERSION,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    lastRunSummary,
    killSwitch,
  };
};

module.exports = { start, stop, runOnce, tick, getStatus };
