const mongoose = require('mongoose');
const blockchainSyncService = require('./blockchainSyncService');

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

// Probe an HTTP service health route with timeout + latency capture.
// Tries {path} (default "/health") and falls back to "/" on 404 so services
// that only expose a root route still report correctly.
const probeHttpService = async (baseUrl, { path = '/health', label } = {}) => {
  const timeout = getProbeTimeoutMs();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const attempt = async (url) => {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
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

    return {
      status: isDegraded ? 'degraded' : 'up',
      latencyMs,
      url: maskUrlHost(baseUrl),
      details: {
        httpStatus: res.status,
        status: serviceStatus || 'ok',
        model_loaded: body?.model_loaded ?? null,
        gemini_status: body?.gemini_status ?? body?.gemini ?? null,
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
    },
    error: null,
    checkedAt: nowIso(),
  };
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
  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
  const genaiServiceUrl = process.env.GENAI_SERVICE_URL || 'http://localhost:8001';

  const [mongodb, aiService, genaiService, blockchain] = await Promise.all([
    probeMongo(),
    probeHttpService(aiServiceUrl, { label: 'ai_service' }),
    probeHttpService(genaiServiceUrl, { label: 'genai-service' }),
    probeBlockchain(),
  ]);

  const backend = probeBackend();

  const components = { mongodb, aiService, genaiService, blockchain, backend };

  return {
    overall: deriveOverall(components),
    components,
    checkedAt: nowIso(),
  };
};

module.exports = {
  getHealth,
  // exported for testing / reuse
  probeMongo,
  probeBlockchain,
  probeBackend,
  probeHttpService,
  deriveOverall,
  formatUptime,
  maskUrlHost,
  scrubMessage,
  withTimeout,
};
