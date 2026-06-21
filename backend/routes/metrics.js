const { renderMetrics } = require('../services/metrics/prometheus');
const { logger } = require('../utils/logger');

const isMetricsEnabled = () =>
  String(process.env.METRICS_ENABLED || 'true').toLowerCase() !== 'false';

const authorizeMetrics = (req, res) => {
  const token = String(process.env.METRICS_TOKEN || '').trim();
  if (!token) return true;

  const auth = req.get('authorization') || '';
  if (auth === `Bearer ${token}`) return true;
  if (req.get('x-metrics-token') === token) return true;

  res.status(401).set('Content-Type', 'text/plain').send('Unauthorized\n');
  return false;
};

const metricsHandler = (req, res) => {
  if (!isMetricsEnabled()) {
    return res.status(404).set('Content-Type', 'text/plain').send('Not Found\n');
  }
  if (!authorizeMetrics(req, res)) return;

  try {
    const body = renderMetrics();
    res.status(200).set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(body);
  } catch (err) {
    logger.error('metrics render failed', { err });
    res.status(500).set('Content-Type', 'text/plain').send('Internal Server Error\n');
  }
};

module.exports = { metricsHandler, isMetricsEnabled };
