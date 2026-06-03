export const forecastSummary = (predictions) => {
  if (!predictions?.length) {
    return { avgGeneration: 0, avgConsumption: 0, avgConfidence: 0 };
  }
  const len = predictions.length;
  return {
    avgGeneration:
      predictions.reduce((acc, curr) => acc + curr.predicted_generation, 0) / len,
    avgConsumption:
      predictions.reduce((acc, curr) => acc + curr.predicted_consumption, 0) / len,
    avgConfidence:
      (predictions.reduce((acc, curr) => acc + (curr.confidence ?? 0), 0) / len) * 100,
  };
};
