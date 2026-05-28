const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api/v1';
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
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

async function parseResponse(response) {
  return response.json().catch(() => ({}));
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
    const response = await fetch(url, {
      ...options,
      headers: buildHeaders(options.token || token),
      body: options.body,
    });

    const data = await parseResponse(response);

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
        data
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
  getStatus: () => fetchApi('/analytics/status'),
  syncBlockchain: () => fetchApi('/analytics/sync', { method: 'POST' }),
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
