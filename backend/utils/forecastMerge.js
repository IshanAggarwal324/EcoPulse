const toTimestampKey = (value) => new Date(value).toISOString();

const addNumeric = (base, delta) => (Number(base) || 0) + (Number(delta) || 0);

/**
 * Sum per-node forecast predictions into a single aggregate series (platform-style
 * totals scoped to the provided node forecasts).
 */
const mergeForecastPredictions = (forecasts = []) => {
  const byTimestamp = new Map();

  for (const entry of forecasts) {
    for (const pred of entry.predictions || []) {
      const key = toTimestampKey(pred.timestamp);
      const existing = byTimestamp.get(key);

      if (!existing) {
        byTimestamp.set(key, {
          timestamp: pred.timestamp,
          predicted_generation: Number(pred.predicted_generation) || 0,
          predicted_consumption: Number(pred.predicted_consumption) || 0,
          generation_lower: Number(pred.generation_lower) || 0,
          generation_upper: Number(pred.generation_upper) || 0,
          consumption_lower: Number(pred.consumption_lower) || 0,
          consumption_upper: Number(pred.consumption_upper) || 0,
          confidence: Number(pred.confidence) || 0,
          count: 1,
        });
        continue;
      }

      existing.predicted_generation = addNumeric(existing.predicted_generation, pred.predicted_generation);
      existing.predicted_consumption = addNumeric(existing.predicted_consumption, pred.predicted_consumption);
      existing.generation_lower = addNumeric(existing.generation_lower, pred.generation_lower);
      existing.generation_upper = addNumeric(existing.generation_upper, pred.generation_upper);
      existing.consumption_lower = addNumeric(existing.consumption_lower, pred.consumption_lower);
      existing.consumption_upper = addNumeric(existing.consumption_upper, pred.consumption_upper);
      existing.confidence = addNumeric(existing.confidence, pred.confidence);
      existing.count += 1;
    }
  }

  return [...byTimestamp.values()]
    .sort((a, b) => toTimestampKey(a.timestamp).localeCompare(toTimestampKey(b.timestamp)))
    .map(({ count, confidence, ...rest }) => ({
      ...rest,
      confidence: count > 0 ? confidence / count : 0,
    }));
};

module.exports = { mergeForecastPredictions };
