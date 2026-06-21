/**
 * Structured JSON logger (H16).
 *
 * Emits one JSON object per line to stdout/stderr for log aggregation
 * (CloudWatch, Datadog, Loki, etc.). Request correlation IDs are picked up
 * from AsyncLocalStorage when set by correlationId middleware.
 */

const { AsyncLocalStorage } = require('async_hooks');

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const requestContext = new AsyncLocalStorage();

const currentLevel = () => LOG_LEVELS[String(process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase()] ?? LOG_LEVELS.info;

const serializeError = (err) => {
  if (!err) return undefined;
  if (typeof err === 'string') return { message: err };
  return {
    message: err.message || String(err),
    name: err.name || undefined,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  };
};

const write = (level, message, fields = {}) => {
  if (LOG_LEVELS[level] < currentLevel()) return;

  const ctx = requestContext.getStore() || {};
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    service: 'ecopulse-backend',
    ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...fields,
  };

  if (entry.err) {
    entry.err = serializeError(entry.err);
  }

  const line = `${JSON.stringify(entry)}\n`;
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
};

const child = (bindings = {}) => ({
  debug: (msg, fields) => write('debug', msg, { ...bindings, ...fields }),
  info: (msg, fields) => write('info', msg, { ...bindings, ...fields }),
  warn: (msg, fields) => write('warn', msg, { ...bindings, ...fields }),
  error: (msg, fields) => write('error', msg, { ...bindings, ...fields }),
  child: (more) => child({ ...bindings, ...more }),
});

const logger = child();

const runWithContext = (context, fn) => requestContext.run(context, fn);

const getCorrelationId = () => requestContext.getStore()?.correlationId || null;

/**
 * Log a non-fatal background failure without throwing (H18).
 */
const logBackgroundError = (scope, err, meta = {}) => {
  logger.warn('background operation failed', {
    scope,
    err,
    ...meta,
  });
};

module.exports = {
  logger,
  child,
  runWithContext,
  getCorrelationId,
  logBackgroundError,
  requestContext,
};
