const MAX_LIVE_READINGS = 20;

export function normalizeReading(reading) {
  const nodeId = reading.nodeId?._id || reading.nodeId;
  const timestamp = reading.timestamp || new Date().toISOString();
  const id = reading._id || `${nodeId}-${timestamp}`;

  return {
    id: String(id),
    nodeId,
    energyGenerated: reading.energyGenerated || 0,
    energyConsumed: reading.energyConsumed || 0,
    timestamp,
    nodeName: reading.nodeId?.name || reading.nodeName,
  };
}

export function prependReading(prev, reading, max = MAX_LIVE_READINGS) {
  const norm = normalizeReading(reading);
  const next = [norm, ...prev.filter((r) => r.id !== norm.id)];
  return next.length > max ? next.slice(0, max) : next;
}

export function readingsFromSummary(recentReadings = []) {
  return recentReadings.map(normalizeReading);
}

/** Merge lightweight socket snapshot without resetting the live feed or carbon stats. */
export function mergeRealtimeSummary(prev, patch) {
  if (!patch) return prev;
  if (!prev) {
    return {
      energy: patch.energy,
      nodes: patch.nodes,
      trades: patch.trades,
      carbon: patch.carbon,
      syncedAt: patch.syncedAt,
    };
  }

  return {
    ...prev,
    energy: patch.energy ?? prev.energy,
    nodes: patch.nodes ?? prev.nodes,
    trades: patch.trades ?? prev.trades,
    syncedAt: patch.syncedAt ?? prev.syncedAt,
  };
}

/** Full summary from REST or scope=full socket — may refresh recent readings. */
export function applyFullSummary(data, { replaceReadings = true } = {}) {
  if (!data) return { summary: null, readings: null };

  const summary = {
    energy: data.energy,
    nodes: data.nodes,
    trades: data.trades,
    carbon: data.carbon,
    syncedAt: data.syncedAt,
    periodHours: data.periodHours,
  };

  const readings = replaceReadings && data.recentReadings?.length
    ? readingsFromSummary(data.recentReadings)
    : null;

  return { summary, readings };
}
