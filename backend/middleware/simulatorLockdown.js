/**
 * Simulator lockdown middleware (Sub-module 1.4.1 + guardrail 1.4).
 *
 * "Simulator endpoints disabled when NODE_ENV=production && INGESTION_MODE=public_api".
 *
 * Mount this on simulator MUTATION routes (config update, restart, reset,
 * enable toggle). Read-only endpoints (config GET, readings, preview) remain
 * available so an operator can still inspect the locked state — they just
 * cannot mutate it. Returns a structured 403 with the resolved mode so the
 * frontend can show a precise "why" message.
 */
const ingestionMode = require('../config/ingestionMode');

const simulatorLockdown = (req, res, next) => {
  if (ingestionMode.isSimulatorLockedDown()) {
    return res.status(403).json({
      success: false,
      code: 'SIMULATOR_LOCKED_DOWN',
      message:
        'The simulator is locked down in this environment (production with ' +
        `INGESTION_MODE=${ingestionMode.getIngestionMode()}). ` +
        'Demo/seed data is disabled to protect live billing and trading.',
      mode: ingestionMode.getIngestionMode(),
    });
  }
  return next();
};

module.exports = simulatorLockdown;
