import { useCallback, useEffect, useRef, useState } from 'react';
import { forecastApi, ApiError } from '../utils/api';
import { useVisibilityPolling } from './useVisibilityPolling';

/**
 * Per-node forecast hooks — Module 9.2.
 *
 * Surfaces AI forecasts beyond the Forecasts page: a singular hook for an
 * expandable full chart and a bulk hook (one `/forecast?allNodes=true` call)
 * for compact dashboard sparklines.
 *
 * Production guard rails:
 *   - Model-unavailable fallback to `useDummy` so the UI stays functional when
 *     the AI service is down (mirrors Forecasts.jsx).
 *   - Visibility-aware polling: pauses while the tab is hidden and re-fetches on
 *     focus, so we never burn requests in the background.
 *   - Stale-response guard: a monotonically increasing request token ensures
 *     only the latest in-flight fetch's results are applied — late returns from
 *     a previous `nodeId`/`horizon`/refresh are discarded (race-condition guard).
 *   - `forecastApi` uses credentials + CSRF; the backend `/forecast` route is
 *     auth-guarded and scopes nodes to the caller, so no client-side trust is
 *     required for ownership.
 */

const DEFAULT_HORIZON = 7;
const DEFAULT_POLL_MS = 10 * 60 * 1000; // 10 min (within the spec's 5–15 min)

const isModelUnavailable = (err) => {
  if (!(err instanceof ApiError)) return false;
  // Rate limiting and other 4xx client errors are NOT model-unavailable: never
  // auto-retry them (a 429 retry would just hit the same throttled path and
  // double the load). Only a genuine model-unavailable (503 / MODEL_UNAVAILABLE)
  // should fall back to dummy data.
  if (err.status === 429 || (err.status >= 400 && err.status < 500)) return false;
  const detailsText = JSON.stringify(err.details || {});
  return (
    err.code === 'MODEL_UNAVAILABLE' ||
    detailsText.includes('MODEL_UNAVAILABLE') ||
    (err.status === 503 && /error communicating with ai service/i.test(err.message || ''))
  );
};

/**
 * Pure: summarize a predictions series for sparkline + compact readouts.
 * Exported (and mirrored in tests). Defensive against missing/odd fields so a
 * malformed model response can never produce NaN in the UI.
 */
export const summarizeForecast = (predictions = []) => {
  if (!Array.isArray(predictions) || predictions.length === 0) {
    return {
      avgGeneration: 0,
      avgConsumption: 0,
      avgConfidence: 0,
      peakGeneration: 0,
      pointCount: 0,
      generationSeries: [],
    };
  }

  const safe = predictions.map((p) => ({
    generation: Number(p?.predicted_generation) || 0,
    consumption: Number(p?.predicted_consumption) || 0,
    confidence: Number.isFinite(p?.confidence) ? Math.max(0, Math.min(1, p.confidence)) : 0,
  }));

  const len = safe.length;
  const avgGeneration = safe.reduce((s, p) => s + p.generation, 0) / len;
  const avgConsumption = safe.reduce((s, p) => s + p.consumption, 0) / len;
  const peakGeneration = safe.reduce((m, p) => Math.max(m, p.generation), 0);

  return {
    avgGeneration,
    avgConsumption,
    avgConfidence: (safe.reduce((s, p) => s + p.confidence, 0) / len) * 100,
    peakGeneration,
    pointCount: len,
    generationSeries: safe.map((p) => p.generation),
  };
};

/**
 * Pure: map a bulk `allNodes` response into `{ [nodeId]: predictions }`.
 * Exported (and mirrored in tests).
 */
export const mapForecastsByNodeId = (forecasts = []) => {
  const byNodeId = {};
  if (!Array.isArray(forecasts)) return byNodeId;
  for (const entry of forecasts) {
    const id = entry?.nodeId;
    if (id && Array.isArray(entry.predictions)) {
      byNodeId[String(id)] = entry.predictions;
    }
  }
  return byNodeId;
};

/**
 * Singular per-node forecast. Used by expandable detail rows.
 *
 * @param {object}  opts
 * @param {string}  opts.nodeId   Mongo node id (server enforces ownership).
 * @param {number}  opts.horizon  Days (7/14/30).
 * @param {boolean} opts.enabled  Skip fetching when false.
 * @param {number}  opts.pollMs   Optional visibility-aware poll interval.
 */
export function useNodeForecast({ nodeId, horizon = DEFAULT_HORIZON, enabled = true, pollMs = 0 }) {
  const [predictions, setPredictions] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqIdRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    if (!enabled || !nodeId) {
      reqIdRef.current += 1;
      setPredictions([]);
      setMeta(null);
      setLoading(false);
      setError(null);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      let data;
      try {
        data = await forecastApi.get(horizon, { nodeId, horizon });
      } catch (err) {
        if (isModelUnavailable(err)) {
          data = await forecastApi.get(horizon, { nodeId, useDummy: true, horizon });
        } else {
          throw err;
        }
      }
      if (reqIdRef.current !== myId) return; // stale
      setPredictions(Array.isArray(data?.predictions) ? data.predictions : []);
      setMeta(data?.meta || null);
    } catch (err) {
      if (reqIdRef.current !== myId) return; // stale
      setError(err instanceof ApiError ? err.message : 'Failed to load forecast');
      setPredictions([]);
      setMeta(null);
    } finally {
      if (reqIdRef.current === myId) setLoading(false);
    }
  }, [nodeId, horizon, enabled]);

  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  useVisibilityPolling(fetchOnce, enabled && pollMs ? pollMs : 0, !!nodeId);

  return { predictions, meta, loading, error, refresh: fetchOnce };
}

/**
 * Bulk per-node forecasts in a single call. Used for dashboard sparklines so we
 * never fire one request per node.
 */
export function useNodeForecasts({ horizon = DEFAULT_HORIZON, enabled = true, pollMs = DEFAULT_POLL_MS } = {}) {
  const [byNodeId, setByNodeId] = useState({});
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const reqIdRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    if (!enabled) return;
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      let data;
      try {
        data = await forecastApi.get(horizon, { allNodes: true, horizon });
        setUsingFallback(false);
      } catch (err) {
        if (isModelUnavailable(err)) {
          data = await forecastApi.get(horizon, { allNodes: true, useDummy: true, horizon });
          setUsingFallback(true);
        } else {
          throw err;
        }
      }
      if (reqIdRef.current !== myId) return; // stale
      setByNodeId(mapForecastsByNodeId(data?.forecasts));
      setMeta(data?.meta || null);
    } catch (err) {
      if (reqIdRef.current !== myId) return; // stale
      setError(err instanceof ApiError ? err.message : 'Failed to load forecasts');
      setByNodeId({});
      setMeta(null);
    } finally {
      if (reqIdRef.current === myId) setLoading(false);
    }
  }, [horizon, enabled]);

  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  useVisibilityPolling(fetchOnce, enabled && pollMs ? pollMs : 0, enabled);

  return { byNodeId, meta, loading, error, refresh: fetchOnce, usingFallback };
}

export default useNodeForecast;
