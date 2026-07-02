const mongoose = require('mongoose');
const blockchainSyncService = require('./blockchainSyncService');
const { getAiServiceUrl, getGenaiServiceUrl } = require('../config/serviceUrls');
const { getCorrelationId } = require('../utils/logger');

const nowIso = () => new Date().toISOString();

const getProbeTimeoutMs = () => {
  const parsed = parseInt(process.env.HEALTH_PROBE_TIMEOUT_MS || '5000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
};

const getSyncLagThreshold = () => {
  const parsed = parseInt(process.env.HEALTH_SYNC_LAG_THRESHOLD || '50', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
};

// Race a promise against a timeout so a single dead/slow dependency cannot
// stall the whole health check. Resolves to { ok, value } or { ok:false }.
const withTimeout = (promise, timeoutMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      })
      .catch((error) => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      });
  });

// Reduce an RPC URL to its hostname so keys/paths/auth are never exposed.
const maskUrlHost = (url) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname || null;
  } catch {
    return null;
  }
};

// Strip any embedded URLs (incl. those carrying API keys/paths) from error
// messages before they are surfaced to clients.
const scrubMessage = (message) => {
  if (!message) return null;
  return String(message)
    .replace(/https?:\/\/[^\s'"<>]+/g, '[url]')
    .replace(/[a-zA-Z0-9.-]+\.(alchemy|infura|eth)\.[a-zA-Z0-9./_-]+/g, '[host]')
    .slice(0, 240);
};

const formatUptime = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
};

// Service statuses that indicate a partial/backup mode rather than full health.
const DEGRADED_STATUSES = ['degraded', 'fallback', 'unhealthy', 'error', 'partial'];

/* ------------------------------------------------------------------ */
/* Module 7.1 — Shared health contract (shared/healthContract.json)    */
/* ------------------------------------------------------------------ */

const HEALTH_SCHEMA_VERSION = '1.0';
const BACKEND_SERVICE_NAME = 'ecopulse-backend';

// Map any internal probe/overall status to the v1 contract enum.
// Internal probes use up/down/degraded; overall uses healthy/degraded/down.
// Unknown / missing values are treated as unhealthy (fail-closed).
const normalizeToContractStatus = (status) => {
  switch (String(status || '').toLowerCase()) {
    case 'up':
    case 'healthy':
    case 'ready':
    case 'ok':
      return 'healthy';
    case 'degraded':
    case 'partial':
    case 'fallback':
      return 'degraded';
    case 'down':
    case 'unhealthy':
    case 'error':
    case 'not_ready':
    case 'notready':
      return 'unhealthy';
    default:
      return 'unhealthy';
  }
};

// Stable check identifiers surfaced in the contract (decoupled from the
// internal component key used by legacy consumers).
const COMPONENT_TO_CHECK_ID = {
  mongodb: 'mongodb',
  aiService: 'ai_service',
  genaiService: 'genai_service',
  blockchain: 'blockchain',
  frontend: 'frontend',
  backend: 'backend',
  simulator: 'simulator',
};

// Derive the contract's `status` as the WORST of the overall + every check,
// so a failing dependency can never read as healthy.
const deriveContractStatus = (overall, checks) => {
  const rank = { healthy: 0, degraded: 1, unhealthy: 2 };
  let worst = normalizeToContractStatus(overall);
  for (const check of checks) {
    if (rank[check.status] > rank[worst]) worst = check.status;
  }
  return worst;
};

// Map the existing component probe results into the contract's checks[].
// Component statuses are normalized to the v1 enum; details are passed through
// unchanged (probes already scrub secrets via scrubMessage/maskUrlHost).
const buildChecks = (components) =>
  Object.entries(components || {}).map(([key, probe]) => ({
    id: COMPONENT_TO_CHECK_ID[key] || key,
    status: normalizeToContractStatus(probe?.status),
    latencyMs: Number.isFinite(probe?.latencyMs) ? Math.round(probe.latencyMs) : null,
    details: probe?.details ?? {},
    ...(probe?.error ? { error: probe.error } : {}),
  }));

// Convert the internal getHealth() result into a v1 health-contract payload.
// Pure function (no I/O) — safe to unit test and reuse by the aggregator.
const toHealthContract = (health) => {
  const components = health?.components || {};
  const checks = buildChecks(components);
  const status = deriveContractStatus(health?.overall, checks);
  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    service: BACKEND_SERVICE_NAME,
    status,
    checkedAt: health?.checkedAt || nowIso(),
    uptimeSeconds: Math.floor(process.uptime()),
    checks,
  };
};

/* ------------------------------------------------------------------ */
/* Module 7.2 — Public status aggregator (safe-fields projection)      */
/* ------------------------------------------------------------------ */

// A check is "ready for traffic" only when a CRITICAL dependency has NOT
// failed entirely. Partial (non-critical) degradation must NOT pull the whole
// backend out of the load-balancer rotation — that would amplify a single
// impaired subsystem (e.g. the GenAI chatbot) into a full platform outage.
// Callers that want strict semantics can read `status !== 'healthy'` instead.
const isReadyForTraffic = (health) =>
  normalizeToContractStatus(health?.status || health?.overall) !== 'unhealthy';

const boolOrNull = (value) =>
  value === true || value === false ? value : null;

const pickDefined = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
};

// Whitelist of NON-SENSITIVE detail fields exposed per service on the PUBLIC
// /api/health/status endpoint. Everything else (hosts, ports, db names, RPC
// hosts, block numbers, PIDs, versions, error messages) is stripped.
const projectSafeDetails = (id, details) => {
  const d = details || {};
  switch (id) {
    case 'ai_service':
      return pickDefined({ model_loaded: boolOrNull(d.model_loaded) });
    case 'genai_service':
      return pickDefined({ available: boolOrNull(d.available) });
    case 'blockchain':
      return pickDefined({ isSyncHealthy: boolOrNull(d.isSyncHealthy) });
    default:
      return {};
  }
};

const projectSafeService = (check) => {
  const out = { status: check.status };
  if (Number.isFinite(check.latencyMs)) out.latencyMs = check.latencyMs;
  const safeDetails = projectSafeDetails(check.id, check.details);
  if (Object.keys(safeDetails).length > 0) out.details = safeDetails;
  return out;
};

// Build the public aggregator payload: a `services` map keyed by check id,
// each entry containing only status + latency + whitelisted safe details.
// No error strings, no internal addresses, no counts beyond the whitelist.
const toPublicStatus = (health) => {
  const checks = health?.checks || buildChecks(health?.components || {});
  const status = health?.status || deriveContractStatus(health?.overall, checks);
  const services = {};
  for (const check of checks) {
    services[check.id] = projectSafeService(check);
  }
  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    service: BACKEND_SERVICE_NAME,
    status,
    overall: status, // alias kept for frontend/back-compat with the plan's shape
    checkedAt: health?.checkedAt || nowIso(),
    uptimeSeconds: Math.floor(process.uptime()),
    services,
  };
};

// Probe an HTTP service health route with timeout + latency capture.
// Tries {path} (default "/health") and falls back to "/" on 404 so services
// that only expose a root route still report correctly.
const probeHttpService = async (baseUrl, { path = '/health', label } = {}) => {
  const timeout = getProbeTimeoutMs();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const attempt = async (url) => {
    // Module 7.4 — forward the active correlation id so health probes are
    // traceable on the downstream Python service. Already-sanitized upstream.
    const cid = getCorrelationId();
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(cid ? { 'x-request-id': cid } : {}),
      },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { res, body };
  };

  try {
    let { res, body } = await attempt(`${baseUrl}${path}`);

    if (res.status === 404 && path !== '/') {
      ({ res, body } = await attempt(`${baseUrl}/`));
    }

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      return {
        status: 'down',
        latencyMs,
        url: maskUrlHost(baseUrl),
        details: body || { httpStatus: res.status },
        error: `HTTP ${res.status}`,
        checkedAt: nowIso(),
      };
    }

    const serviceStatus = String(
      body?.status || body?.health || (body?.ok ? 'ok' : '') || 'ok'
    ).toLowerCase();
    const isDegraded = DEGRADED_STATUSES.includes(serviceStatus);

    // Module 7.1 changed Python services to the v1 contract. genai no longer
    // sends `gemini_status`/`gemini`; it sends `available` (+ `checks[]`).
    // Read the actual fields each service emits so the parser stays aligned.
    const contractChecks = Array.isArray(body?.checks) ? body.checks : null;

    return {
      status: isDegraded ? 'degraded' : 'up',
      latencyMs,
      url: maskUrlHost(baseUrl),
      details: {
        httpStatus: res.status,
        status: serviceStatus || 'ok',
        // ai_service readiness (LSTM model artifacts loaded).
        model_loaded: body?.model_loaded ?? null,
        // genai-service readiness (Gemini configured/enabled).
        available: body?.available ?? null,
        // v1 contract checks[] when the downstream service returns them.
        ...(contractChecks ? { checks: contractChecks } : {}),
        version: body?.version ?? null,
      },
      error: null,
      checkedAt: nowIso(),
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      url: maskUrlHost(baseUrl),
      details: null,
      error:
        error.name === 'AbortError'
          ? `Timed out after ${timeout}ms`
          : scrubMessage(error.message) || `${label || 'Service'} unreachable`,
      checkedAt: nowIso(),
    };
  } finally {
    clearTimeout(timer);
  }
};

const probeMongo = async () => {
  const startedAt = Date.now();
  const readyState = mongoose.connection.readyState;

  if (readyState !== 1) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      details: { readyState },
      error: `MongoDB not connected (readyState ${readyState})`,
      checkedAt: nowIso(),
    };
  }

  try {
    const pingResult = await mongoose.connection.db?.admin?.().ping();
    if (!pingResult?.ok) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        details: { readyState },
        error: 'ping did not return ok',
        checkedAt: nowIso(),
      };
    }

    return {
      status: 'up',
      latencyMs: Date.now() - startedAt,
      details: {
        readyState,
        host: mongoose.connection.host || null,
        port: mongoose.connection.port || null,
        name: mongoose.connection.name || null,
      },
      error: null,
      checkedAt: nowIso(),
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      details: { readyState },
      error: scrubMessage(error.message) || 'MongoDB ping failed',
      checkedAt: nowIso(),
    };
  }
};

const probeBlockchain = async () => {
  const startedAt = Date.now();
  const rpcHost = maskUrlHost(process.env.RPC_URL);
  try {
    // Bound the RPC probe so a partitioned/unresponsive provider cannot hang
    // the whole health check (the ethers provider itself has no request timeout).
    const result = await withTimeout(
      blockchainSyncService.getChainStatus(),
      getProbeTimeoutMs()
    );

    if (!result.ok) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        details: {
          rpcHost,
          syncLagThreshold: getSyncLagThreshold(),
        },
        error: result.error
          ? scrubMessage(result.error.message)
          : `Blockchain probe timed out after ${getProbeTimeoutMs()}ms`,
        checkedAt: nowIso(),
      };
    }

    const chain = result.value;
    const latencyMs = Date.now() - startedAt;

    if (!chain.connected) {
      return {
        status: 'down',
        latencyMs,
        details: {
          rpcHost,
          syncLagThreshold: getSyncLagThreshold(),
        },
        error: scrubMessage(chain.error) || 'Blockchain provider unreachable',
        checkedAt: nowIso(),
      };
    }

    return {
      status: chain.isSyncHealthy ? 'up' : 'degraded',
      latencyMs,
      details: {
        chainName: chain.chainName,
        chainId: chain.chainId,
        blockNumber: chain.blockNumber,
        lastSyncedBlock: chain.lastSyncedBlock,
        syncLagBlocks: chain.syncLagBlocks,
        syncLagThreshold: getSyncLagThreshold(),
        isSyncHealthy: chain.isSyncHealthy,
        tradeCount: chain.tradeCount,
        nextListingId: chain.nextListingId,
        rpcHost,
        lastSync: chain.lastSync || null,
      },
      error: null,
      checkedAt: nowIso(),
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      details: {
        rpcHost,
        syncLagThreshold: getSyncLagThreshold(),
      },
      error: scrubMessage(error.message) || 'Blockchain probe failed',
      checkedAt: nowIso(),
    };
  }
};

const probeBackend = () => {
  const mem = process.memoryUsage();

  // Ingestion counters are informational (process-local). Lazy-required so a
  // failure in the metrics module can never break the backend self-probe.
  let ingestion = null;
  try {
    // eslint-disable-next-line global-require
    const ingestionMetrics = require('./ingestion/ingestionMetrics');
    const snapshot = ingestionMetrics.getSnapshot();
    ingestion = {
      accepted: snapshot.counters?.accepted ?? 0,
      rejected: snapshot.counters?.rejected ?? 0,
      duplicate: snapshot.counters?.duplicate ?? 0,
    };
  } catch {
    ingestion = null;
  }

  return {
    status: 'up',
    latencyMs: 0,
    details: {
      uptimeSeconds: Math.floor(process.uptime()),
      uptimeLabel: formatUptime(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
      memory: {
        rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        externalMb: Math.round((mem.external / 1024 / 1024) * 10) / 10,
      },
      ...(ingestion ? { ingestion } : {}),
    },
    error: null,
    checkedAt: nowIso(),
  };
};

// Simulator is informational only — it is never a critical component. When the
// runner is not embedded we report 'up' (intentionally off). When embedded and
// enabled but not running, that is worth flagging as degraded.
const probeSimulator = () => {
  let status;
  try {
    // Lazy require to avoid coupling module-load order.
    // eslint-disable-next-line global-require
    const simulatorManager = require('./simulatorManager');
    status = simulatorManager.getStatus();
  } catch {
    return {
      status: 'up',
      latencyMs: 0,
      details: { embedded: false, note: 'Simulator manager unavailable' },
      error: null,
      checkedAt: nowIso(),
    };
  }

  if (!status.embedded) {
    return {
      status: 'up',
      latencyMs: 0,
      details: { embedded: false, note: 'Runner not embedded (CLI mode)' },
      error: null,
      checkedAt: nowIso(),
    };
  }

  if (!status.enabled) {
    return {
      status: 'up',
      latencyMs: 0,
      details: {
        embedded: true,
        enabled: false,
        running: status.running,
        note: 'Disabled by config',
      },
      error: null,
      checkedAt: nowIso(),
    };
  }

  if (!status.running) {
    return {
      status: 'degraded',
      latencyMs: 0,
      details: { embedded: true, enabled: true, running: false },
      error: 'Embedded simulator enabled but not running',
      checkedAt: nowIso(),
    };
  }

  return {
    status: 'up',
    latencyMs: 0,
    details: {
      embedded: true,
      enabled: true,
      running: true,
      nodes: status.nodes,
      ticks: status.ticks,
      readingsEmitted: status.readingsEmitted,
      intervalMs: status.intervalMs,
      startedAt: status.startedAt,
    },
    error: null,
    checkedAt: nowIso(),
  };
};

// Frontend is a static SPA, so probing it is opt-in via FRONTEND_HEALTH_URL
// (a CDN/static host serving a health.json, or any reachable health route).
// When unset we report 'up' (informational/off). When set but unreachable we
// flag 'down' (degrades overall). Never critical, so it never forces overall
// 'down'. The configured URL is masked to its hostname in the output.
const getFrontendHealthUrl = () => String(process.env.FRONTEND_HEALTH_URL || '').trim();

const isValidHttpUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const probeFrontend = async () => {
  const url = getFrontendHealthUrl();
  if (!url) {
    return {
      status: 'up',
      latencyMs: 0,
      details: { configured: false, note: 'FRONTEND_HEALTH_URL not set' },
      error: null,
      checkedAt: nowIso(),
    };
  }

  if (!isValidHttpUrl(url)) {
    return {
      status: 'down',
      latencyMs: 0,
      details: { configured: true },
      error: 'FRONTEND_HEALTH_URL is not a valid http(s) URL',
      checkedAt: nowIso(),
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getProbeTimeoutMs());
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        status: 'down',
        latencyMs,
        url: maskUrlHost(url),
        details: { configured: true, httpStatus: res.status },
        error: `HTTP ${res.status}`,
        checkedAt: nowIso(),
      };
    }
    return {
      status: 'up',
      latencyMs,
      url: maskUrlHost(url),
      details: { configured: true, httpStatus: res.status },
      error: null,
      checkedAt: nowIso(),
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      url: maskUrlHost(url),
      details: { configured: true },
      error:
        error.name === 'AbortError'
          ? `Timed out after ${getProbeTimeoutMs()}ms`
          : scrubMessage(error.message) || 'Frontend unreachable',
      checkedAt: nowIso(),
    };
  } finally {
    clearTimeout(timer);
  }
};

// MongoDB and the backend process are critical: if either is down the whole
// platform is down. Other components (AI, GenAI, blockchain) being unavailable
// only degrades the experience.
const CRITICAL_COMPONENTS = ['mongodb', 'backend'];

const deriveOverall = (components) => {
  const statuses = Object.entries(components).map(([key, probe]) => ({
    key,
    status: probe?.status || 'down',
  }));

  const anyCriticalDown = statuses.some(
    ({ key, status }) => CRITICAL_COMPONENTS.includes(key) && status === 'down'
  );
  if (anyCriticalDown) return 'down';

  const anyDownOrDegraded = statuses.some(
    ({ status }) => status === 'down' || status === 'degraded'
  );
  if (anyDownOrDegraded) return 'degraded';

  return 'healthy';
};

// Run every probe in parallel so a single slow/dead service cannot stall the
// whole health check. Each probe resolves (never rejects) with a normalized
// shape, so Promise.all is safe here.
const getHealth = async () => {
  const aiServiceUrl = getAiServiceUrl();
  const genaiServiceUrl = getGenaiServiceUrl();

  const [mongodb, aiService, genaiService, blockchain, frontend] = await Promise.all([
    probeMongo(),
    probeHttpService(aiServiceUrl, { label: 'ai_service' }),
    probeHttpService(genaiServiceUrl, { label: 'genai-service' }),
    probeBlockchain(),
    probeFrontend(),
  ]);

  const backend = probeBackend();
  const simulator = probeSimulator();

  const components = {
    mongodb,
    aiService,
    genaiService,
    blockchain,
    frontend,
    backend,
    simulator,
  };
  const overall = deriveOverall(components);
  const checks = buildChecks(components);

  return {
    // v1 health-contract fields (Module 7.1) — see shared/healthContract.json.
    schemaVersion: HEALTH_SCHEMA_VERSION,
    service: BACKEND_SERVICE_NAME,
    status: deriveContractStatus(overall, checks),
    uptimeSeconds: Math.floor(process.uptime()),
    checks,
    // Legacy fields retained for backward compatibility with existing
    // consumers (admin controller, analytics, /api/health/ready, tests).
    overall,
    components,
    checkedAt: nowIso(),
  };
};

module.exports = {
  getHealth,
  // v1 health-contract helpers (Module 7.1)
  toHealthContract,
  normalizeToContractStatus,
  deriveContractStatus,
  buildChecks,
  HEALTH_SCHEMA_VERSION,
  BACKEND_SERVICE_NAME,
  // public status aggregator + readiness (Module 7.2)
  toPublicStatus,
  isReadyForTraffic,
  projectSafeService,
  projectSafeDetails,
  probeFrontend,
  // exported for testing / reuse
  probeMongo,
  probeBlockchain,
  probeBackend,
  probeSimulator,
  probeHttpService,
  deriveOverall,
  formatUptime,
  maskUrlHost,
  scrubMessage,
  withTimeout,
};
