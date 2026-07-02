/**
 * Lightweight Prometheus metrics registry (H17).
 *
 * No external dependency — exposes process, HTTP, and ingestion counters/gauges
 * in Prometheus text exposition format for scraping or load-balancer probes.
 */

const ingestionMetrics = require('../ingestion/ingestionMetrics');

const startTime = Date.now();

const counters = new Map();
const gauges = new Map();
const histograms = new Map();

const counterKey = (name, labels) => {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
};

const incCounter = (name, labels = {}, value = 1) => {
  const key = counterKey(name, labels);
  counters.set(key, (counters.get(key) || 0) + value);
};

const setGauge = (name, labels, value) => {
  const key = counterKey(name, labels);
  gauges.set(key, value);
};

const observeHistogram = (name, labels, valueMs) => {
  const key = counterKey(name, labels);
  const bucket = histograms.get(key) || { count: 0, sumMs: 0 };
  bucket.count += 1;
  bucket.sumMs += valueMs;
  histograms.set(key, bucket);
};

const HELP = {
  ecopulse_http_requests_total: 'Total HTTP requests handled',
  ecopulse_http_request_duration_ms: 'HTTP request duration in milliseconds',
  ecopulse_ingestion_accepted_total: 'Telemetry messages accepted',
  ecopulse_ingestion_rejected_total: 'Telemetry messages rejected',
  ecopulse_ingestion_duplicate_total: 'Duplicate telemetry messages',
  ecopulse_ingestion_rejected_persist_skipped_total: 'Rejected messages skipped for dead-letter persist',
  ecopulse_process_uptime_seconds: 'Process uptime',
  ecopulse_nodejs_heap_used_bytes: 'Node.js heap used',
  ecopulse_dependency_health: 'Health of a probed dependency (1=healthy, 0.5=degraded, 0=down)',
};

const recordHttpRequest = ({ method, route, statusCode, durationMs }) => {
  incCounter('ecopulse_http_requests_total', {
    method: method || 'UNKNOWN',
    route: route || 'unknown',
    status: String(statusCode || 0),
  });
  observeHistogram('ecopulse_http_request_duration_ms', {
    method: method || 'UNKNOWN',
    route: route || 'unknown',
  }, durationMs);
};

// Module 7.5 — dependency health gauge. Maps the v1 health-contract status enum
// (plus legacy up/down) to a numeric gauge so Prometheus can alert on a failing
// dependency. Unknown statuses fail closed to 0 (down).
const DEPENDENCY_STATUS_VALUE = {
  healthy: 1,
  up: 1,
  ready: 1,
  degraded: 0.5,
  fallback: 0.5,
  partial: 0.5,
  unhealthy: 0,
  down: 0,
  error: 0,
};

const recordDependencyHealth = (checks) => {
  for (const check of checks || []) {
    const status = String(check?.status || '').toLowerCase();
    const value = DEPENDENCY_STATUS_VALUE[status] ?? 0;
    setGauge('ecopulse_dependency_health', { service: check.id || 'unknown' }, value);
  }
};

const normalizeRoute = (req) => {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    return `${base}${req.route.path}`.replace(/\/+/g, '/') || '/';
  }
  if (req.path === '/api/health') return '/api/health';
  if (req.path === '/metrics') return '/metrics';
  return 'unmatched';
};

const renderLine = (type, name, value, labels = null) => {
  if (labels) {
    const labelStr = Object.keys(labels)
      .sort()
      .map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`)
      .join(',');
    return `${name}{${labelStr}} ${value}`;
  }
  return `${name} ${value}`;
};

const renderMetrics = () => {
  const snap = ingestionMetrics.getSnapshot();
  setGauge('ecopulse_ingestion_accepted_total', {}, snap.counters.accepted);
  setGauge('ecopulse_ingestion_rejected_total', {}, snap.counters.rejected);
  setGauge('ecopulse_ingestion_duplicate_total', {}, snap.counters.duplicate);
  setGauge(
    'ecopulse_ingestion_rejected_persist_skipped_total',
    {},
    snap.counters.rejectedPersistSkipped || 0,
  );
  setGauge('ecopulse_process_uptime_seconds', {}, (Date.now() - startTime) / 1000);
  setGauge('ecopulse_nodejs_heap_used_bytes', {}, process.memoryUsage().heapUsed);

  const lines = ['# HELP ecopulse metrics for EcoPulse backend', '# TYPE ecopulse_info gauge', 'ecopulse_info{service="backend"} 1'];

  for (const [name, help] of Object.entries(HELP)) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${name.includes('duration') || name.includes('uptime') || name.includes('bytes') || name.includes('heap') ? 'gauge' : name.includes('http_requests') ? 'counter' : 'gauge'}`);
  }

  for (const [key, value] of counters.entries()) {
    lines.push(`${key} ${value}`);
  }
  for (const [key, value] of gauges.entries()) {
    lines.push(`${key} ${value}`);
  }
  for (const [key, bucket] of histograms.entries()) {
    lines.push(`${key}_count ${bucket.count}`);
    lines.push(`${key}_sum ${bucket.sumMs}`);
  }

  return `${lines.join('\n')}\n`;
};

module.exports = {
  recordHttpRequest,
  normalizeRoute,
  renderMetrics,
  incCounter,
  setGauge,
  recordDependencyHealth,
};
