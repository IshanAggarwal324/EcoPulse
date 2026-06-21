import { useEffect, useRef } from 'react';

/**
 * Poll only while the document tab is visible (M13).
 */
export function useVisibilityPolling(callback, intervalMs, enabled = true) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;

    let intervalId = null;

    const tick = () => savedCallback.current();

    const stop = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const start = () => {
      stop();
      intervalId = setInterval(tick, intervalMs);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        tick();
        start();
      }
    };

    if (!document.hidden) {
      start();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, intervalMs]);
}
