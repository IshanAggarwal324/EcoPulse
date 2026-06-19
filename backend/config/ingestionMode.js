/**
 * Ingestion mode configuration (Sub-module 1.4.1 — Environment-driven modes).
 *
 * Centralizes the `INGESTION_MODE` resolution so every module (simulator
 * manager, device path, public-grid poller, admin dashboard, backfill) reads
 * one source of truth about which ingestion sources are active.
 *
 * Modes:
 *   - simulated   : simulator only (dev/demo). Real-data paths disabled.
 *   - device      : IoT device telemetry only. Simulator locked down in prod.
 *   - public_api  : public grid APIs only. Simulator locked down in prod.
 *   - hybrid      : simulator + real-data paths coexist (dev default).
 *
 * Defaults (the plan's recommended defaults):
 *   - Development: `hybrid` — simulator + public APIs allowed, IoT optional.
 *   - Production : `public_api` — simulator OFF, public APIs ON, IoT optional.
 *
 * Security guardrail (1.4): in production + `public_api`, the simulator is
 * LOCKED DOWN — its mutation endpoints return 403 and the embedded runner
 * refuses to start. This prevents demo/seed data from ever mixing with
 * billing/trading decisions in a live environment.
 */

const VALID_MODES = ['simulated', 'device', 'public_api', 'hybrid'];

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Resolve the default mode based on environment when INGESTION_MODE is unset
 * or invalid. Dev → hybrid, prod → public_api.
 */
const getDefaultMode = () => (isProduction() ? 'public_api' : 'hybrid');

/**
 * Resolve and validate the active ingestion mode. An explicit but invalid
 * value falls back to the environment default (with a server-side warning) so a
 * misconfiguration can never enable a source that should be off — fail-closed.
 */
const getIngestionMode = () => {
  const raw = String(process.env.INGESTION_MODE || '').trim().toLowerCase();
  if (raw && VALID_MODES.includes(raw)) return raw;
  return getDefaultMode();
};

/**
 * Whether the explicit env value was set but invalid (used by env validation
 * to surface a startup warning without crashing the process).
 */
const hasInvalidMode = () => {
  const raw = String(process.env.INGESTION_MODE || '').trim().toLowerCase();
  return Boolean(raw) && !VALID_MODES.includes(raw);
};

// ── Capability flags (per-source allowed?) ──────────────────────────────────
const isSimulatorAllowed = () => {
  const mode = getIngestionMode();
  return mode === 'simulated' || mode === 'hybrid';
};

const isDeviceAllowed = () => {
  const mode = getIngestionMode();
  return mode === 'device' || mode === 'hybrid';
};

const isPublicApiAllowed = () => {
  const mode = getIngestionMode();
  return mode === 'public_api' || mode === 'hybrid';
};

/**
 * Production lockdown of the simulator (guardrail 1.4: "Simulator endpoints
 * disabled when NODE_ENV=production && INGESTION_MODE=public_api").
 *
 * The simulator is force-locked whenever we are in production and the resolved
 * mode excludes the simulator (public_api or device). In dev the simulator is
 * always reachable for demo/seed purposes.
 */
const isSimulatorLockedDown = () =>
  isProduction() && !isSimulatorAllowed();

/**
 * Coarse flag: is ANY IoT (device) path enabled at all? Distinct from the
 * DEVICE_AUTH_ENABLED flag (which gates the credential/provisioning subsystem);
 * this reflects the INGESTION_MODE capability.
 */
const isIotEnabled = () => isDeviceAllowed();

/**
 * Snapshot for the admin ingestion dashboard / health endpoint.
 */
const getStatus = () => {
  const mode = getIngestionMode();
  return {
    mode,
    defaultMode: getDefaultMode(),
    environment: isProduction() ? 'production' : 'development',
    valid: !hasInvalidMode(),
    explicit: Boolean(String(process.env.INGESTION_MODE || '').trim()),
    capabilities: {
      simulator: isSimulatorAllowed(),
      device: isDeviceAllowed(),
      publicApi: isPublicApiAllowed(),
    },
    lockdowns: {
      simulatorLockedDown: isSimulatorLockedDown(),
    },
  };
};

module.exports = {
  VALID_MODES,
  isProduction,
  getIngestionMode,
  getDefaultMode,
  hasInvalidMode,
  isSimulatorAllowed,
  isDeviceAllowed,
  isPublicApiAllowed,
  isSimulatorLockedDown,
  isIotEnabled,
  getStatus,
};
