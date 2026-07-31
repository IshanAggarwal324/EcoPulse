const ApiError = require('../utils/apiError');

/**
 * CORS origin allow-list.
 *
 * A rejected origin must surface as a CLIENT error: returning a bare `Error`
 * to the cors callback lands in errorHandler with no status and is reported as
 * `500 INTERNAL_ERROR`, which pollutes 5xx metrics and error-rate alerting with
 * requests that were correctly refused (audit finding #3).
 */
const parseCorsOrigins = () =>
  String(process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const buildCorsOptions = ({ isProduction = process.env.NODE_ENV === 'production' } = {}) => {
  const configuredOrigins = parseCorsOrigins();

  return {
    origin(origin, callback) {
      // Same-origin / non-browser callers (curl, health checks) send no Origin.
      if (!origin) return callback(null, true);
      // Dev convenience: with no allow-list configured, accept any origin.
      if (configuredOrigins.length === 0 && !isProduction) {
        return callback(null, true);
      }
      if (configuredOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new ApiError('CORS blocked for this origin', 403, 'CORS_BLOCKED'));
    },
    credentials: true,
    exposedHeaders: ['X-CSRF-Token'],
  };
};

module.exports = { buildCorsOptions, parseCorsOrigins };
