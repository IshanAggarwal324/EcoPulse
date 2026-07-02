const { getCorrelationId, getTraceparent } = require('./logger');
const { sanitizeCorrelationId, sanitizeTraceparent } = require('./correlation');

/**
 * Shared fetch wrapper with AbortSignal timeout (M5) + correlation and
 * traceparent propagation (Module 7.4 / Module 7.6).
 *
 * The request correlation id is forwarded as `x-request-id` and the W3C
 * traceparent as `traceparent` on every outbound call so ai_service /
 * genai-service can trace a request end-to-end. When the caller has not already
 * set a header, the values are pulled from the active request context
 * (AsyncLocalStorage); any caller-supplied value is sanitized/validated
 * (control chars stripped; traceparent matched against the exact W3C grammar)
 * before being sent so an upstream attacker cannot smuggle CRLF/header-injection
 * payloads across the hop.
 */
const CORRELATION_HEADER = 'x-request-id';
const TRACEPARENT_HEADER = 'traceparent';

/**
 * Build the outbound header object with a single, sanitized `x-request-id` and a
 * valid `traceparent`. Exported for unit testing.
 */
function buildOutboundHeaders(rawHeaders) {
  const headers = { ...(rawHeaders || {}) };

  // --- x-request-id (correlation) ---
  let explicitCid;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === CORRELATION_HEADER) {
      explicitCid = headers[key];
      delete headers[key];
    }
  }
  const resolvedCid =
    explicitCid !== undefined ? sanitizeCorrelationId(explicitCid) : getCorrelationId();
  if (resolvedCid) headers[CORRELATION_HEADER] = resolvedCid;

  // --- traceparent (W3C trace context) ---
  let explicitTp;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === TRACEPARENT_HEADER) {
      explicitTp = headers[key];
      delete headers[key];
    }
  }
  const resolvedTp =
    explicitTp !== undefined ? sanitizeTraceparent(explicitTp) : getTraceparent();
  if (resolvedTp) headers[TRACEPARENT_HEADER] = resolvedTp;

  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = null) {
  const parsed = parseInt(
    timeoutMs ?? process.env.UPSTREAM_FETCH_TIMEOUT_MS ?? '20000',
    10,
  );
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 20000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, {
      ...options,
      headers: buildOutboundHeaders(options.headers),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout, buildOutboundHeaders };
