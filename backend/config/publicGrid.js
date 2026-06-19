/**
 * Public grid API ingestion configuration (Sub-module 1.5).
 *
 * Centralizes every env-driven knob for the public-grid poller so the worker,
 * service, adapters, and admin endpoints read one source of truth. Defaults are
 * fail-closed: ingestion is OFF until a deployment opts in.
 *
 * Security posture (guardrails 1.5):
 *   - `PUBLIC_GRID_INGESTION_ENABLED=false` disables every poller without
 *     affecting the simulator or the IoT path.
 *   - Outbound requests are HTTPS-only and restricted to hostnames each adapter
 *     explicitly declares (SSRF allowlist — an admin cannot register an
 *     arbitrary poll URL). `isPrivateHost` adds defense-in-depth by blocking
 *     loopback / private / link-local / metadata addresses even if a host were
 *     somehow resolvable to one.
 *   - API keys live in env only. The `PublicGridSource` document stores the
 *     *name* of the env var (`apiKeyEnvVar`), never the secret itself.
 */

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isPublicGridEnabled = () => toBool(process.env.PUBLIC_GRID_INGESTION_ENABLED, false);

// Coarse capability check honoring the global INGESTION_MODE. The poller must
// only run when public APIs are an allowed source for this deployment.
const ingestionMode = require('./ingestionMode');
const isPublicApiAllowed = () =>
  isPublicGridEnabled() && ingestionMode.isPublicApiAllowed();

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_POLL_INTERVAL_MS = 60 * 1000; // never hammer a provider faster than 1/min

const getDefaultPollInterval = () => {
  const parsed = toInt(process.env.PUBLIC_GRID_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  return Math.max(parsed, MIN_POLL_INTERVAL_MS);
};

// Outbound HTTP timeout — a single dead provider must not stall the poll loop.
const DEFAULT_FETCH_TIMEOUT_MS = 10 * 1000;
const getFetchTimeoutMs = () => toInt(process.env.PUBLIC_GRID_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS);

// Circuit breaker (1.5.7): trip a source open after N consecutive failures and
// hold it open (skip polls) for a cooldown before a single half-open probe.
const DEFAULT_CB_FAILURE_THRESHOLD = 5;
const DEFAULT_CB_COOLDOWN_MS = 15 * 60 * 1000;
const getCbFailureThreshold = () =>
  toInt(process.env.PUBLIC_GRID_CB_FAILURE_THRESHOLD, DEFAULT_CB_FAILURE_THRESHOLD);
const getCbCooldownMs = () => toInt(process.env.PUBLIC_GRID_CB_COOLDOWN_MS, DEFAULT_CB_COOLDOWN_MS);

// Dedup window for public-api readings.
const DEFAULT_DEDUP_TTL_SECONDS = 24 * 60 * 60;
const getDedupTtlSeconds = () => toInt(process.env.PUBLIC_GRID_DEDUP_TTL_SECONDS, DEFAULT_DEDUP_TTL_SECONDS);

// Provider-side jitter window so all sources don't fire at the same wall-clock
// tick and to be a good citizen toward free APIs.
const DEFAULT_JITTER_MS = 30 * 1000;
const getJitterMs = () => toInt(process.env.PUBLIC_GRID_JITTER_MS, DEFAULT_JITTER_MS);

// Per-source outlier rejection: reject any reading above this ceiling (MW)
// unless the source configures its own `maxCapacityMw`. National grids can be
// large, so this is a generous sanity bound against corrupt/overflow payloads.
const DEFAULT_MAX_CAPACITY_MW = 2_000_000; // 2,000 GW — planetary absurdity guard
const getDefaultMaxCapacityMw = () =>
  toInt(process.env.PUBLIC_GRID_DEFAULT_MAX_CAPACITY_MW, DEFAULT_MAX_CAPACITY_MW);

// Terms-of-use compliance: minimum cache for provider responses. Providers
// (e.g. SMARD) license data under CC BY 4.0 and ask that clients not poll more
// often than the data actually updates. The poller enforces the source's
// pollIntervalMs (>= MIN_POLL_INTERVAL_MS) as the effective cache window.
const DEDUP_PREFIX = 'publicgrid:dedup';

/**
 * Defense-in-depth SSRF guard. Returns true for loopback / private / link-local
 * / carrier-grade NAT / cloud metadata addresses. The primary SSRF control is
 * the per-adapter host allowlist (an admin cannot inject a URL), but if a
 * allowlisted hostname were ever DNS-rebinding'd to an internal address this
 * blocks it.
 */
const isPrivateHost = (hostname) => {
  if (!hostname) return true;
  const host = String(hostname).toLowerCase().replace(/\.+$/, '');

  // DNS-rebinding / metadata hostnames that must never be reachable.
  if (host === 'localhost' || host === 'metadata.google.internal' || host === 'metadata') {
    return true;
  }

  // IPv4 literal.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map((n) => parseInt(n, 10));
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this" network
    if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 literal — block ::, ::1, fc00::/7 (unique local), fe80::/10 (link-local).
  const v6 = host.match(/^[0-9a-f:]+$/i);
  if (v6) {
    if (host === '::' || host === '::1') return true;
    if (/^fc/.test(host) || /^fd/.test(host)) return true; // unique local
    if (/^fe[89ab]/.test(host)) return true; // link-local
    // IPv4-mapped / compatible.
    if (/^::ffff:/.test(host)) {
      const mapped = host.replace(/^::ffff:/, '');
      return isPrivateHost(mapped);
    }
    return false;
  }

  return false;
};

module.exports = {
  isPublicGridEnabled,
  isPublicApiAllowed,
  getDefaultPollInterval,
  getFetchTimeoutMs,
  getCbFailureThreshold,
  getCbCooldownMs,
  getDedupTtlSeconds,
  getJitterMs,
  getDefaultMaxCapacityMw,
  isPrivateHost,
  DEDUP_PREFIX,
  MIN_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_CB_FAILURE_THRESHOLD,
  DEFAULT_CB_COOLDOWN_MS,
  DEFAULT_DEDUP_TTL_SECONDS,
  DEFAULT_MAX_CAPACITY_MW,
};
