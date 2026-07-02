const { getCorrelationId } = require('./logger');
const { sanitizeCorrelationId } = require('./correlation');

/**
 * Shared fetch wrapper with AbortSignal timeout (M5) + correlation propagation
 * (Module 7.4).
 *
 * The request correlation id is forwarded as `x-request-id` on every outbound
 * call so ai_service / genai-service can trace a request end-to-end. When the
 * caller has not already set the header, the id is pulled from the active
 * request context (AsyncLocalStorage); any caller-supplied value is sanitized
 * (control chars stripped, length bounded) before being sent so an upstream
 * attacker cannot smuggle CRLF/header-injection payloads across the hop.
 */
const CORRELATION_HEADER = 'x-request-id';

/**
 * Build the outbound header object with a single, sanitized `x-request-id`.
 * Exported for unit testing.
 */
function buildOutboundHeaders(rawHeaders) {
  const headers = { ...(rawHeaders || {}) };

  let explicitValue;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === CORRELATION_HEADER) {
      explicitValue = headers[key];
      delete headers[key];
    }
  }

  const resolved =
    explicitValue !== undefined ? sanitizeCorrelationId(explicitValue) : getCorrelationId();

  if (resolved) headers[CORRELATION_HEADER] = resolved;
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
