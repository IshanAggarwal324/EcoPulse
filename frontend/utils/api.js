const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5001/api/v1';
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5001';

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

  const buildHeaders = (token) => ({
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    ...(token && !skipAuth ? { Authorization: `Bearer ${token}` } : {}),
  });

  const execute = async (token, isRetry = false) => {
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: buildHeaders(options.token || token),
        body: options.body,
        signal: controller.signal,
      });
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
        return execute(refreshed, true);
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

  const token = skipAuth ? null : authHandlers.getAccessToken();
  return execute(token);
}

export const authApi = {
  getMe: () => fetchApi('/auth/me'),
  updateProfile: (body) => fetchApi('/auth/profile', { method: 'PUT', body: JSON.stringify(body) }),
  updatePassword: (body) => fetchApi('/auth/password', { method: 'PUT', body: JSON.stringify(body) }),
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

export const marketplaceApi = {
  getOrders: (params = {}) => {
    const query = new URLSearchParams(params).toString();
    return fetchApi(`/marketplace/orders${query ? `?${query}` : ''}`);
  },
  getOrder: (listingId) => fetchApi(`/marketplace/orders/${listingId}`),
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
    return fetchApi(`/forecast?${params}`);
  },
};

export const assistantApi = {
  chat: (message, sessionId, history) =>
    fetchApi('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        ...(sessionId ? { sessionId } : {}),
        ...(history?.length ? { conversationHistory: history } : {}),
      }),
    }),

  generateReport: ({ period, scope, delivery }) =>
    fetchApi('/assistant/report', {
      method: 'POST',
      body: JSON.stringify({ period, scope, delivery }),
    }),
};
