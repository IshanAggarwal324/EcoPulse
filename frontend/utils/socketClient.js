import { SOCKET_URL } from './api';

const parseIntEnv = (key, fallback) => {
  const raw = import.meta.env[key];
  if (raw === undefined || raw === '') return fallback;
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
  reconnectionAttempts: parseIntEnv('VITE_SOCKET_RECONNECT_ATTEMPTS', 20),
  reconnectionDelay: parseIntEnv('VITE_SOCKET_RECONNECT_DELAY_MS', 1000),
  reconnectionDelayMax: parseIntEnv('VITE_SOCKET_RECONNECT_DELAY_MAX_MS', 10000),
  timeout: parseIntEnv('VITE_SOCKET_CONNECT_TIMEOUT_MS', 20000),
});

export { SOCKET_URL };
