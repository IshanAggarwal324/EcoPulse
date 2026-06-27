const isProd = import.meta.env.PROD;

const normalizeUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const envApiBase = normalizeUrl(import.meta.env.VITE_API_URL);
if (isProd && !envApiBase) {
  throw new Error('VITE_API_URL must be configured in production');
}

export const API_BASE = envApiBase || 'http://localhost:5001/api/v1';

const envSocketUrl = normalizeUrl(import.meta.env.VITE_SOCKET_URL);
if (isProd && !envSocketUrl) {
  throw new Error('VITE_SOCKET_URL must be configured in production');
}

export const SOCKET_URL = envSocketUrl || 'http://localhost:5001';

export class ApiError extends Error {
  constructor(message, status, details, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

let authHandlers = {
  getAccessToken: () => null,
  refreshSession: async () => false,
  onSessionExpired: () => {},
};

export function configureApiAuth(handlers) {
  authHandlers = { ...authHandlers, ...handlers };
}

const DEFAULT_TIMEOUT_MS = 20000;
let csrfTokenCache = null;

function getCsrfTokenFromCookie() {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function cacheCsrfTokenFromResponse(response) {
  const token = response?.headers?.get?.('x-csrf-token');
  if (token) {
    csrfTokenCache = token;
  }
}

async function ensureCsrfToken() {
  if (csrfTokenCache) return csrfTokenCache;

  try {
    const response = await fetch(`${API_BASE}/auth/captcha-config`, {
      method: 'GET',
      credentials: 'include',
    });
    cacheCsrfTokenFromResponse(response);
  } catch {
    // Best-effort bootstrap: normal request path will still run and report errors.
  }

  return csrfTokenCache;
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text().catch(() => '');

  if (!raw) return {};
  if (contentType.includes('application/json')) {
    return JSON.parse(raw);
  }

  return {
    message: raw.slice(0, 500),
    raw,
  };
}

export async function fetchApi(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const skipAuth = options.skipAuth === true;
  const method = String(options.method || 'GET').toUpperCase();

  const buildHeaders = (csrfToken) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = csrfToken || csrfTokenCache || getCsrfTokenFromCookie();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    return headers;
  };

  const execute = async (isRetry = false) => {
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      let csrfToken = null;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        csrfToken = await ensureCsrfToken();
      }

      response = await fetch(url, {
        ...options,
        headers: buildHeaders(csrfToken),
        body: options.body,
        signal: controller.signal,
        credentials: 'include',
      });
      cacheCsrfTokenFromResponse(response);
    } catch (error) {
      const isTimeout = error?.name === 'AbortError';
      throw new ApiError(
        isTimeout
          ? `Request timed out after ${timeoutMs}ms`
          : 'Network request failed',
        0,
        { cause: error?.message || String(error), url, method: options.method || 'GET' },
        isTimeout ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timeout);
    }

    let data = {};
    try {
      data = await parseResponse(response);
    } catch {
      data = { message: 'Invalid API response format' };
    }

    if (
      response.status === 401 &&
      !skipAuth &&
      !isRetry &&
      (data.code === 'TOKEN_EXPIRED' || data.code === 'TOKEN_INVALID')
    ) {
      const refreshed = await authHandlers.refreshSession();
      if (refreshed) {
        // The refresh set a fresh httpOnly cookie, which the browser will now
        // send automatically on retry — no bearer token needed.
        return execute(true);
      }
      authHandlers.onSessionExpired();
    }

    if (!response.ok) {
      throw new ApiError(
        data.message || `Request failed (${response.status})`,
        response.status,
        data,
        data.code || null,
      );
    }

    return data;
  };

  return execute();
}

export const authApi = {
  getMe: () => fetchApi('/auth/me'),
  getCaptchaConfig: () => fetchApi('/auth/captcha-config', { skipAuth: true }),
  updateProfile: (body) => fetchApi('/auth/profile', { method: 'PUT', body: JSON.stringify(body) }),
  updatePassword: (body) => fetchApi('/auth/password', { method: 'PUT', body: JSON.stringify(body) }),
  logout: () => fetchApi('/auth/logout', { method: 'POST' }),
  verifyEmail: (token) =>
    fetchApi('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
      skipAuth: true,
    }),
  resendVerification: (email) =>
    fetchApi('/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify(email ? { email } : {}),
    }),
};

export const analyticsApi = {
  getSummary: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/analytics/summary${query ? `?${query}` : ''}`);
  },
  getCarbonBalance: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/analytics/carbon/balance${query ? `?${query}` : ''}`);
  },
  getStatus: () => fetchApi('/analytics/status'),
  syncBlockchain: () => fetchApi('/analytics/sync', { method: 'POST' }),
};

// Module 5.3.6 — carbon lifecycle (retirements, bridge, totals).
export const carbonApi = {
  getTotals: () => fetchApi('/carbon/totals'),
  getBalance: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/carbon/balance${query ? `?${query}` : ''}`);
  },
  getRetirements: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/carbon/retirements${query ? `?${query}` : ''}`);
  },
  indexRetirement: (txHash) =>
    fetchApi('/carbon/retirements', { method: 'POST', body: JSON.stringify({ txHash }) }),
  getBridgeTransfers: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/carbon/bridge/transfers${query ? `?${query}` : ''}`);
  },
  indexBridge: (txHash) =>
    fetchApi('/carbon/bridge/index', { method: 'POST', body: JSON.stringify({ txHash }) }),
};

export const marketplaceApi = {
  getOrders: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/marketplace/orders${query ? `?${query}` : ''}`);
  },
  getOrder: (listingId) => fetchApi(`/marketplace/orders/${listingId}`),
  // Order book (Sub-module 6.1)
  getOrderBook: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/marketplace/orderbook${query ? `?${query}` : ''}`);
  },
  getOrderBookDepth: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/marketplace/orderbook/depth${query ? `?${query}` : ''}`);
  },
  getBuyOrders: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/marketplace/orderbook/buy-orders${query ? `?${query}` : ''}`);
  },
  createBuyOrder: (body) =>
    fetchApi('/marketplace/orderbook/buy-orders', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelBuyOrder: (id) =>
    fetchApi(`/marketplace/orderbook/buy-orders/${id}`, { method: 'DELETE' }),
  submitRating: (body) =>
    fetchApi('/marketplace/ratings', { method: 'POST', body: JSON.stringify(body) }),
  listRatings: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/marketplace/ratings${query ? `?${query}` : ''}`);
  },
  getReputation: (wallet) => fetchApi(`/marketplace/reputation/${wallet}`),
  getNodeReputation: (nodeId) => fetchApi(`/marketplace/reputation/node/${nodeId}`),
};

// Module 6.4 — settlement status. `verify` triggers on-chain receipt
// verification server-side (rate-limited); the read endpoints return the
// lifecycle-enriched settlement for the caller (buyer/seller scoped).
export const settlementsApi = {
  verify: (txHash, listingId) =>
    fetchApi('/settlements/verify', {
      method: 'POST',
      body: JSON.stringify({ txHash, listingId }),
    }),
  getById: (id) => fetchApi(`/settlements/${id}`),
  listMine: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/marketplace/settlements${query ? `?${query}` : ''}`);
  },
  getMyByTradeId: (tradeId) => fetchApi(`/marketplace/settlements/${tradeId}`),
  getForOrder: (listingId) => fetchApi(`/marketplace/orders/${listingId}/settlement`),
};

export const tradesApi = {
  getHistory: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/trades/history${query ? `?${query}` : ''}`);
  },
  syncHistory: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/trades/history/sync${query ? `?${query}` : ''}`);
  },
  getByTxHash: (txHash) => fetchApi(`/trades/tx/${txHash}`),
};

export const nodesApi = {
  getAll: () => fetchApi('/nodes'),
};

export const readingsApi = {
  getRecent: (limit = 20) => fetchApi(`/readings?limit=${limit}`),
};

export const forecastApi = {
  get: (days = 7, options = {}) => {
    const params = new URLSearchParams({ days: String(days) });
    if (options.nodeId) params.set('nodeId', options.nodeId);
    if (options.nodeIds?.length) params.set('nodeIds', options.nodeIds.join(','));
    if (options.allNodes) params.set('allNodes', 'true');
    if (options.useDummy) params.set('useDummy', 'true');
    if (options.horizon) params.set('horizon', String(options.horizon));
    if (options.modelScope) params.set('modelScope', options.modelScope);
    return fetchApi(`/forecast?${params}`);
  },
};

export const anomalyApi = {
  // Scans the caller's nodes (or a specific node) for meter anomalies.
  list: (options = {}) => {
    const params = new URLSearchParams({ days: String(options.days || 14) });
    if (options.nodeId) params.set('nodeId', options.nodeId);
    if (options.allNodes) params.set('allNodes', 'true');
    if (options.persist === false) params.set('persist', 'false');
    if (options.since) params.set('since', options.since);
    return fetchApi(`/anomaly?${params}`);
  },
};

export const pricingApi = {
  getCurve: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/pricing/curve${query ? `?${query}` : ''}`);
  },
  getRecommendation: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/pricing/recommendations${query ? `?${query}` : ''}`);
  },
};

// Sub-module 2.3 — Auto-listing policy + signed-intent enable.
export const autoTradingApi = {
  getEip712Domain: () => fetchApi('/trading/auto-policy/eip712-domain'),
  listPolicies: () => fetchApi('/trading/auto-policy'),
  getPolicy: (id) => fetchApi(`/trading/auto-policy/${id}`),
  createPolicy: (body) =>
    fetchApi('/trading/auto-policy', { method: 'POST', body: JSON.stringify(body) }),
  updatePolicy: (id, body) =>
    fetchApi(`/trading/auto-policy/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePolicy: (id) => fetchApi(`/trading/auto-policy/${id}`, { method: 'DELETE' }),
  enablePolicy: (id, body) =>
    fetchApi(`/trading/auto-policy/${id}/enable`, { method: 'POST', body: JSON.stringify(body) }),
  disablePolicy: (id) =>
    fetchApi(`/trading/auto-policy/${id}/disable`, { method: 'POST', body: JSON.stringify({}) }),
};

// Sub-module 2.3.5 — in-app notifications (user-scoped).
export const notificationApi = {
  list: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/trading/notifications${query ? `?${query}` : ''}`);
  },
  markRead: (id) => fetchApi(`/trading/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () => fetchApi('/trading/notifications/read-all', { method: 'POST' }),
  dismiss: (id) => fetchApi(`/trading/notifications/${id}/dismiss`, { method: 'POST' }),
};

export const assistantApi = {
  chat: (message, sessionId, history, context = {}) =>
    fetchApi('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        ...(sessionId ? { sessionId } : {}),
        ...(history?.length ? { conversationHistory: history } : {}),
        ...(context.nodeId ? { nodeId: context.nodeId } : {}),
        ...(context.pageContext ? { pageContext: context.pageContext } : {}),
      }),
    }),

  generateReport: ({ period, scope, delivery }) =>
    fetchApi('/assistant/report', {
      method: 'POST',
      body: JSON.stringify({ period, scope, delivery }),
    }),
};

const buildQuery = (params = {}) => {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, value);
    }
  });
  const str = query.toString();
  return str ? `?${str}` : '';
};

export const adminApi = {
  // Users
  listUsers: (params = {}) => fetchApi(`/admin/users${buildQuery(params)}`),
  getUser: (id) => fetchApi(`/admin/users/${id}`),
  setUserRole: (id, role) =>
    fetchApi(`/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  banUser: (id, reason) =>
    fetchApi(`/admin/users/${id}/ban`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  unbanUser: (id) => fetchApi(`/admin/users/${id}/unban`, { method: 'PATCH' }),
  deleteUser: (id) => fetchApi(`/admin/users/${id}`, { method: 'DELETE' }),

  // Nodes
  listNodes: (params = {}) => fetchApi(`/admin/nodes${buildQuery(params)}`),
  createNode: (body) => fetchApi('/admin/nodes', { method: 'POST', body: JSON.stringify(body) }),
  updateNode: (id, body) => fetchApi(`/admin/nodes/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteNode: (id, params = {}) => fetchApi(`/admin/nodes/${id}${buildQuery(params)}`, { method: 'DELETE' }),

  // Trades
  listTrades: (params = {}) => fetchApi(`/admin/trades${buildQuery(params)}`),
  getTrade: (txHash) => fetchApi(`/admin/trades/${txHash}`),

  // Blockchain sync
  getSyncStatus: () => fetchApi('/admin/sync/status'),
  forceSync: () => fetchApi('/admin/sync/force', { method: 'POST' }),

  // Report jobs
  listReportJobs: (params = {}) => fetchApi(`/admin/report-jobs${buildQuery(params)}`),
  getReportJob: (id) => fetchApi(`/admin/report-jobs/${id}`),
  retryReportJob: (id) => fetchApi(`/admin/report-jobs/${id}/retry`, { method: 'POST' }),

  // Audit logs
  listAuditLogs: (params = {}) => fetchApi(`/admin/audit-logs${buildQuery(params)}`),

  // System health (Phase 5)
  getSystemHealth: () => fetchApi('/admin/health'),

  // Simulator (Phase 6)
  getSimulatorConfig: () => fetchApi('/admin/simulator/config'),
  updateSimulatorConfig: (body) =>
    fetchApi('/admin/simulator/config', { method: 'PUT', body: JSON.stringify(body) }),
  restartSimulator: () => fetchApi('/admin/simulator/restart', { method: 'POST' }),
  resetSimulatorConfig: () => fetchApi('/admin/simulator/reset', { method: 'POST' }),
  getSimulatorReadings: (limit = 20) => fetchApi(`/admin/simulator/readings?limit=${limit}`),
  getSimulatorPreview: (sourceType) => fetchApi(`/admin/simulator/preview?sourceType=${sourceType}`),

  // Ingestion (Sub-module 1.4)
  getIngestionMode: () => fetchApi('/admin/ingestion/mode'),
  getIngestionDashboard: () => fetchApi('/admin/ingestion/dashboard'),
  getIngestionHealth: (sinceHours) =>
    fetchApi(`/admin/ingestion/health${buildQuery(sinceHours ? { sinceHours } : {})}`),
  backfillIngestion: (body) =>
    fetchApi('/admin/ingestion/backfill', { method: 'POST', body: JSON.stringify(body) }),
};
