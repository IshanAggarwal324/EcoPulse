const crypto = require('crypto');

const { renderMetrics } = require('../services/metrics/prometheus');
const { logger } = require('../utils/logger');

const isProduction = () => process.env.NODE_ENV === 'production';

const getMetricsToken = () => String(process.env.METRICS_TOKEN || '').trim();

/**
 * Metrics are opt-out via METRICS_ENABLED=false. In addition, as a production
 * guard rail we REFUSE to expose operational metrics when no METRICS_TOKEN is
 * configured in production — an unauthenticated /metrics leaks internal
 * topology, dependency status, and traffic signal that an attacker can use to
 * map and time the system. Dev (NODE_ENV != production) stays open for
 * convenience.
 */
const isMetricsEnabled = () => {
  if (String(process.env.METRICS_ENABLED || 'true').toLowerCase() === 'false') {
    return false;
  }
  if (isProduction() && !getMetricsToken()) {
    return false;
  }
  return true;
};

/**
 * Constant-time string comparison to avoid a timing side-channel that would
 * let an attacker recover the METRICS_TOKEN byte-by-byte via response timing.
 * The length check does leak token length, but never token contents.
 */
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

const authorizeMetrics = (req, res) => {
  const token = getMetricsToken();
  // No token configured: only reachable in non-production (isMetricsEnabled
  // gates production). Allow for dev convenience.
  if (!token) return true;

  const auth = req.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const xToken = req.get('x-metrics-token') || '';

  if (bearer && safeEqual(bearer, token)) return true;
  if (xToken && safeEqual(xToken, token)) return true;

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

module.exports = { metricsHandler, isMetricsEnabled, authorizeMetrics, safeEqual };
