const { randomUUID } = require('crypto');

/**
 * Correlation ID helpers (Module 7.4).
 *
 * A correlation id flows end-to-end:
 *   inbound `x-request-id` header  ->  AsyncLocalStorage request context
 *   ->  outbound `x-request-id` on calls to ai_service / genai-service
 *   ->  Python contextvar  ->  every Python + Node log line. The resolved id is
 *   also echoed on every HTTP response.
 *
 * SECURITY: the inbound `x-request-id` is fully untrusted. It is stamped into
 * structured JSON logs AND forwarded as an HTTP header, so an unsanitized value
 * enables two production-grade attacks:
 *   1. Log forging / injection — an embedded newline breaks out of the JSON log
 *      line and lets an attacker inject fake log records (covering tracks,
 *      poisoning SIEM alerts, breaking log parsers).
 *   2. HTTP header / response splitting — embedded CR/LF in a header value can
 *      smuggle additional headers on outbound calls or split the response.
 * `sanitizeCorrelationId` strips every character outside a safe charset and
 * bounds the length (also prevents log bloat / DoS via an oversized id). Values
 * that do not survive sanitization yield `null`, so callers fall back to a
 * freshly generated UUID and never trust a malformed id.
 */

const MAX_CORRELATION_ID_LENGTH = 128;
const UNSAFE_CID_CHARS = /[^A-Za-z0-9_-]/g;

/**
 * Reduce an arbitrary inbound value to a safe correlation id, or `null` when it
 * is absent / empty / over-length / contains nothing but disallowed chars.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
const sanitizeCorrelationId = (raw) => {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).replace(UNSAFE_CID_CHARS, '');
  if (cleaned.length === 0 || cleaned.length > MAX_CORRELATION_ID_LENGTH) {
    return null;
  }
  return cleaned;
};

/**
 * Resolve a correlation id for a request. Returns the sanitized inbound value
 * when it is a well-formed id, otherwise a fresh UUID. Never returns null/empty
 * and never returns an untrusted value.
 *
 * @param {unknown} raw
 * @returns {string}
 */
const resolveCorrelationId = (raw) => sanitizeCorrelationId(raw) || randomUUID();

module.exports = {
  sanitizeCorrelationId,
  resolveCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
};
