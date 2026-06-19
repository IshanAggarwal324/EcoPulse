const { SimulatorRunner, configStore } = require('./simulator');
const readingService = require('./readingService');
const ingestionMode = require('../config/ingestionMode');

const RECENT_READINGS_LIMIT = 60;

let runner = null;
let startedAt = null;
const recentReadings = [];
let readingsEmitted = 0;

/**
 * Sub-module 1.4.1 — the embedded simulator respects the ingestion-mode
 * lockdown. In production + public_api/device mode the simulator must NOT run
 * (guardrail 1.4: demo/seed data must never reach a live billing/trading
 * environment). `SIMULATOR_EMBEDDED` is honored only when the simulator is
 * permitted by the active mode.
 */
const isEmbeddedEnabled = () =>
  process.env.SIMULATOR_EMBEDDED === 'true' &&
  process.env.NODE_ENV !== 'production' &&
  ingestionMode.isSimulatorAllowed();

const pushRecent = (reading) => {
  recentReadings.push(reading);
  if (recentReadings.length > RECENT_READINGS_LIMIT) {
    recentReadings.shift();
  }
};

// In-process transport: ingest directly via readingService (no socket round
// trip) and capture the reading into the live-preview ring buffer.
const createEmbeddedTransport = () => ({
  name: 'embedded',
  async send(reading) {
    try {
      await readingService.ingestSimulatedReading({
        nodeId: reading.nodeId,
        energyGenerated: reading.energyGenerated,
        energyConsumed: reading.energyConsumed,
      });
    } catch (err) {
      console.error('[SimulatorManager] ingest failed:', err.message);
    }
    readingsEmitted += 1;
    pushRecent({
      nodeId: String(reading.nodeId),
      name: reading.name || null,
      sourceType: reading.sourceType || null,
      energyGenerated: reading.energyGenerated,
      energyConsumed: reading.energyConsumed,
      timestamp: reading.timestamp,
      failures: reading.failures || null,
    });
    return { ok: true };
  },
  waitForConnect() {
    return Promise.resolve();
  },
  close() {},
});

const buildRunner = () => {
  const r = new SimulatorRunner({ injectedTransport: createEmbeddedTransport() });
  // Capture emitted readings each tick for stats / live preview.
  r.onTick = (emitted) => {
    // Emitted readings are already captured inside transport.send; nothing to
    // do here, but the hook lets future subscribers react to batches.
  };
  return r;
};

const start = async () => {
  if (ingestionMode.isSimulatorLockedDown()) {
    // Defense in depth: even if an admin calls the restart endpoint, refuse to
    // start a live simulator in a production public_api/device environment.
    console.warn('[SimulatorManager] Refusing to start — simulator is locked down by INGESTION_MODE.');
    return null;
  }
  if (runner && runner.running) return runner;
  runner = buildRunner();
  runner.onTick = undefined;
  await runner.start();
  startedAt = new Date();
  console.log('[SimulatorManager] Embedded simulator started');
  return runner;
};

const stop = () => {
  if (!runner) return;
  runner.stop();
  console.log('[SimulatorManager] Embedded simulator stopped');
};

const restart = async () => {
  stop();
  recentReadings.length = 0;
  readingsEmitted = 0;
  return start();
};

// Soft reload: re-read config + node roster without dropping the transport.
const reload = async () => {
  await configStore.reload();
  if (runner) {
    return runner.reload();
  }
  return { nodes: 0 };
};

const startIfEnabled = async () => {
  if (!isEmbeddedEnabled()) {
    return false;
  }
  try {
    await start();
    return true;
  } catch (err) {
    console.error('[SimulatorManager] Failed to start embedded simulator:', err.message);
    return false;
  }
};

const isRunning = () => !!runner && runner.running;

const getStatus = () => ({
  embedded: isEmbeddedEnabled(),
  running: isRunning(),
  enabled: configStore.isEnabled(),
  nodes: runner?.states?.size ?? 0,
  ticks: runner?.tickCount ?? 0,
  readingsEmitted,
  startedAt: startedAt ? startedAt.toISOString() : null,
  recentCount: recentReadings.length,
  intervalMs: configStore.getIntervalMs(),
  jitterMs: configStore.getJitterMs(),
  lockedDown: ingestionMode.isSimulatorLockedDown(),
});

const getRecentReadings = () => [...recentReadings].reverse();

module.exports = {
  start,
  stop,
  restart,
  reload,
  startIfEnabled,
  isRunning,
  getStatus,
  getRecentReadings,
  isEmbeddedEnabled,
};
