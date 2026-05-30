import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import io from 'socket.io-client';
import { getSocketClientOptions, SOCKET_URL } from '../utils/socketClient';

/** @typedef {'connected' | 'disconnected' | 'reconnecting' | 'failed'} SocketStatus */

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const [status, setStatus] = useState(/** @type {SocketStatus} */ ('disconnected'));
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [lastError, setLastError] = useState(null);

  const socket = useMemo(
    () => io(SOCKET_URL, getSocketClientOptions()),
    [],
  );

  const hasConnectedRef = useRef(false);
  const reconnectListenersRef = useRef(new Set());

  const notifyReconnect = useCallback(() => {
    reconnectListenersRef.current.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error('[Socket] Reconnect listener error:', err);
      }
    });
  }, []);

  const reconnect = useCallback(() => {
    setLastError(null);
    setStatus('reconnecting');
    if (socket.disconnected) {
      socket.connect();
    }
  }, [socket]);

  useEffect(() => {
    const onConnect = () => {
      setStatus('connected');
      setReconnectAttempt(0);
      setLastError(null);

      if (hasConnectedRef.current) {
        notifyReconnect();
      }
      hasConnectedRef.current = true;
    };

    const onDisconnect = (reason) => {
      if (reason === 'io server disconnect') {
        setStatus('disconnected');
      } else {
        setStatus('reconnecting');
      }
    };

    const onConnectError = (err) => {
      setLastError(err.message || 'Connection failed');
      if (!hasConnectedRef.current) {
        setStatus('reconnecting');
      }
    };

    const onReconnectAttempt = (attempt) => {
      setStatus('reconnecting');
      setReconnectAttempt(attempt);
    };

    const onReconnectFailed = () => {
      setStatus('failed');
      setLastError('Unable to reach the server. Check that the backend is running.');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.io.on('reconnect_failed', onReconnectFailed);

    if (socket.connected) {
      onConnect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.io.off('reconnect_failed', onReconnectFailed);
      socket.disconnect();
    };
  }, [socket, notifyReconnect]);

  const value = useMemo(
    () => ({
      socket,
      status,
      connected: status === 'connected',
      reconnecting: status === 'reconnecting',
      reconnectAttempt,
      lastError,
      reconnect,
      subscribeReconnect: (listener) => {
        reconnectListenersRef.current.add(listener);
        return () => reconnectListenersRef.current.delete(listener);
      },
    }),
    [socket, status, reconnectAttempt, lastError, reconnect],
  );

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useSocket() {
  const ctx = useContext(SocketContext);
  if (!ctx) {
    throw new Error('useSocket must be used within SocketProvider');
  }
  return ctx;
}

/** Run callback after the socket reconnects (not on the initial connect). */
export function useSocketReconnect(callback) {
  const { subscribeReconnect } = useSocket();
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(
    () => subscribeReconnect(() => callbackRef.current?.()),
    [subscribeReconnect],
  );
}

/** Subscribe to a server event with a stable handler ref (avoids duplicate listeners). */
export function useSocketEvent(event, handler) {
  const { socket } = useSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!event) return undefined;
    const listener = (...args) => handlerRef.current?.(...args);
    socket.on(event, listener);
    return () => socket.off(event, listener);
  }, [socket, event]);
}
