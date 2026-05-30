import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import io from 'socket.io-client';
import { SOCKET_URL } from '../utils/api';

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const [connected, setConnected] = useState(false);

  const socket = useMemo(
    () =>
      io(SOCKET_URL, {
        autoConnect: true,
        transports: ['websocket', 'polling'],
      }),
    [],
  );

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.disconnect();
    };
  }, [socket]);

  const value = useMemo(() => ({ socket, connected }), [socket, connected]);

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
