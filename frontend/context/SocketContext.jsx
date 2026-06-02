import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { io } from 'socket.io-client';
import { getSocketClientOptions, SOCKET_URL } from '../utils/socketClient';

/** @typedef {'connected' | 'disconnected' | 'reconnecting' | 'failed'} SocketStatus */

const SocketApiContext = createContext(null);
const SocketStatusContext = createContext(null);

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

  const subscribeReconnect = useCallback((listener) => {
    reconnectListenersRef.current.add(listener);
    return () => reconnectListenersRef.current.delete(listener);
  }, []);

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

  const apiValue = useMemo(
    () => ({ socket, reconnect, subscribeReconnect }),
    [socket, reconnect, subscribeReconnect],
  );

  const statusValue = useMemo(
    () => ({
      status,
      connected: status === 'connected',
      reconnecting: status === 'reconnecting',
      reconnectAttempt,
      lastError,
    }),
    [status, reconnectAttempt, lastError],
  );

  return (
    <SocketApiContext.Provider value={apiValue}>
      <SocketStatusContext.Provider value={statusValue}>
        {children}
      </SocketStatusContext.Provider>
    </SocketApiContext.Provider>
  );
}

export function useSocketApi() {
  const ctx = useContext(SocketApiContext);
  if (!ctx) {
    throw new Error('useSocketApi must be used within SocketProvider');
  }
  return ctx;
}

export function useSocketStatus() {
  const ctx = useContext(SocketStatusContext);
  if (!ctx) {
    throw new Error('useSocketStatus must be used within SocketProvider');
  }
  return ctx;
}

/** @deprecated Prefer useSocketApi / useSocketStatus for fewer re-renders. */
export function useSocket() {
  return { ...useSocketApi(), ...useSocketStatus() };
}

export function useSocketReconnect(callback) {
  const { subscribeReconnect } = useSocketApi();
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(
    () => subscribeReconnect(() => callbackRef.current?.()),
    [subscribeReconnect],
  );
}

export function useSocketEvent(event, handler) {
  const { socket } = useSocketApi();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!event) return undefined;
    const listener = (...args) => handlerRef.current?.(...args);
    socket.on(event, listener);
    return () => socket.off(event, listener);
  }, [socket, event]);
}
