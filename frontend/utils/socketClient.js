import { SOCKET_URL } from './api';

// NOTE: read each env var with a STATIC `import.meta.env.VITE_*` expression.
// Dynamic access (`import.meta.env[key]`) forces Vite to inline the entire env
// object into the bundle, which published every Vercel system variable
// (committer name, project/deployment IDs, internal preview hostnames).
const parseIntEnv = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

// Backwards-compatible no-op. Socket auth is cookie-based: the access token
// is read from the httpOnly cookie by the server during the handshake, so no
// in-memory token is sent from the client.
export const configureSocketAuth = () => {};

/** Shared Socket.io client options for the frontend. */
export const getSocketClientOptions = () => ({
  autoConnect: true,
  transports: ['websocket', 'polling'],
  withCredentials: true,
  reconnection: true,
  reconnectionAttempts: parseIntEnv(import.meta.env.VITE_SOCKET_RECONNECT_ATTEMPTS, 20),
  reconnectionDelay: parseIntEnv(import.meta.env.VITE_SOCKET_RECONNECT_DELAY_MS, 1000),
  reconnectionDelayMax: parseIntEnv(import.meta.env.VITE_SOCKET_RECONNECT_DELAY_MAX_MS, 10000),
  timeout: parseIntEnv(import.meta.env.VITE_SOCKET_CONNECT_TIMEOUT_MS, 20000),
});

export { SOCKET_URL };
