import { useCallback, useEffect, useRef } from 'react';
import { useSocketEvent } from '../context/SocketContext';
import { SOCKET_EVENTS } from '../constants/socketEvents';
import {
  applyFullSummary,
  mergeRealtimeSummary,
  prependReading,
} from '../utils/dashboardRealtime';

const READING_BATCH_MS = 80;

/**
 * Batches rapid newReading events and applies scoped analytics merges
 * so the dashboard does not double-update or reset the live feed.
 */
export function useDashboardRealtime({ setSummary, setLiveReadings }) {
  const readingBatchRef = useRef([]);
  const readingTimerRef = useRef(null);

  const flushReadingBatch = useCallback(() => {
    const batch = readingBatchRef.current;
    readingBatchRef.current = [];
    readingTimerRef.current = null;
    if (!batch.length) return;

    setLiveReadings((prev) => batch.reduce((acc, r) => prependReading(acc, r), prev));
  }, [setLiveReadings]);

  useSocketEvent(SOCKET_EVENTS.SERVER.NEW_READING, (reading) => {
    readingBatchRef.current.push(reading);
    if (!readingTimerRef.current) {
      readingTimerRef.current = setTimeout(flushReadingBatch, READING_BATCH_MS);
    }
  });

  useSocketEvent(SOCKET_EVENTS.SERVER.ANALYTICS_UPDATE, (payload) => {
    if (!payload) return;

    const { scope, ...data } = payload;

    if (scope === 'realtime') {
      setSummary((prev) => mergeRealtimeSummary(prev, data));
      return;
    }

    const { summary, readings } = applyFullSummary(data);
    if (summary) setSummary((prev) => ({ ...prev, ...summary }));
    if (readings) setLiveReadings(readings);
  });

  useEffect(() => () => {
    if (readingTimerRef.current) {
      clearTimeout(readingTimerRef.current);
    }
  }, []);
}
