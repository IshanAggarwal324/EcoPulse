const { recordHttpRequest, normalizeRoute } = require('../services/metrics/prometheus');

/**
 * Record HTTP request counts and latency for Prometheus (H17).
 */
const metricsMiddleware = (req, res, next) => {
  const started = Date.now();

  res.on('finish', () => {
    recordHttpRequest({
      method: req.method,
      route: normalizeRoute(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
    });
  });

  next();
};

module.exports = metricsMiddleware;
