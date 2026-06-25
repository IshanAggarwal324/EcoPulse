const reconciliationService = require('../services/reconciliationService');

/**
 * Reconciliation Worker — Module 5.2.5
 *
 * setInterval loop mirroring the other workers (rollupWorker, etc.). Each tick:
 *   1. backfills pending Settlement records for newly-indexed purchases,
 *   2. reconciles pending/mismatched settlements against meter telemetry.
 *
 * Safe to call manually (tick()) from tests / admin triggers; the guard flag
 * prevents overlapping ticks. Only starts when ENERGY_TRADING_ADDRESS is set so
 * non-marketplace deployments don't spin an idle loop.
 */

const DEFAULT_INTERVAL_MS = parseInt(process.env.SETTLEMENT_RECONCILE_INTERVAL_MS || '300000', 10);

let timer = null;
let bootstrapTimer = null;
let running = false;
let lastRunAt = null;
let lastRunSummary = null;

const tick = async () => {
  if (running) return;
  running = true;
  try {
    await reconciliationService.ensureSettlementsForPurchases();
    const summary = await reconciliationService.runReconciliation();
    lastRunAt = new Date();
    lastRunSummary = summary;
  } catch (err) {
    console.error('[reconciliationWorker] tick failed:', err.message);
    lastRunSummary = { ok: false, error: err.message };
  } finally {
    running = false;
  }
};

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return false;
  if (!process.env.ENERGY_TRADING_ADDRESS) return false;
  // Stagger first run 90s after boot so the initial sync lands first.
  bootstrapTimer = setTimeout(tick, 90 * 1000);
  timer = setInterval(tick, intervalMs);
  console.log(`[reconciliationWorker] started (every ${intervalMs}ms)`);
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
  }
};

const getStatus = () => ({
  enabled: !!process.env.ENERGY_TRADING_ADDRESS,
  running: !!timer,
  busy: running,
  intervalMs: DEFAULT_INTERVAL_MS,
  lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
  lastRunSummary,
});

module.exports = { start, stop, tick, getStatus };
