const { logger } = require('../utils/logger');

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'password',
  'secret',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'authorization',
  'captcha',
  'captcha_token',
  'recaptcha',
  'hcaptcha',
]);

const redactQueryString = (queryString) => {
  if (!queryString || queryString === '?') return '';

  const params = new URLSearchParams(queryString.startsWith('?') ? queryString.slice(1) : queryString);
  let redacted = false;

  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, '[REDACTED]');
      redacted = true;
    }
  }

  if (!redacted) return queryString.startsWith('?') ? queryString : `?${queryString}`;
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
};

const sanitizeUrlForLog = (url) => {
  const raw = String(url || '/');
  const qIndex = raw.indexOf('?');
  if (qIndex === -1) return raw;
  return `${raw.slice(0, qIndex)}${redactQueryString(raw.slice(qIndex))}`;
};

const requestLogger = (req, res, next) => {
  const path = sanitizeUrlForLog(req.originalUrl || req.url);
  const started = Date.now();

  res.on('finish', () => {
    logger.info('http request', {
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      ip: req.ip,
    });
  });

  next();
};

module.exports = requestLogger;
