const { randomUUID } = require('crypto');

/**
 * Correlation ID helpers (Module 7.4) + W3C traceparent helpers (Module 7.6).
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
 *
 * `traceparent` (Module 7.6) follows the same untrusted-input rule: only a
 * value matching the exact W3C Trace Context grammar is accepted; anything else
 * is replaced with a freshly minted trace context so log forging / header
 * injection is impossible.
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

/* -------------------------------------------------------------------------- */
/* W3C Trace Context — `traceparent` (Module 7.6)                              */
/* -------------------------------------------------------------------------- */

// version(2)-trace_id(32)-parent_id(16)-trace_flags(2), lowercase hex.
const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TRACEPARENT_LENGTH = 55;

/**
 * Validate an inbound `traceparent` against the exact W3C grammar. Returns the
 * lowercased value when well-formed, or `null` when malformed/invalid (so
 * callers mint a fresh trace context and never trust a hostile value).
 *
 * Rejects: non-hex, wrong length, forbidden version `ff`, and all-zero trace or
 * parent ids (invalid per the spec).
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
const sanitizeTraceparent = (raw) => {
  if (raw === undefined || raw === null) return null;
  const candidate = String(raw).trim().toLowerCase();
  if (candidate.length !== TRACEPARENT_LENGTH) return null;
  if (!TRACEPARENT_RE.test(candidate)) return null;
  const [version, traceId, parentId] = candidate.split('-');
  if (version === 'ff') return null;
  if (traceId === '0'.repeat(32) || parentId === '0'.repeat(16)) return null;
  return candidate;
};

/**
 * Mint a fresh, valid traceparent (version 00, sampled flag 01). The trace id is
 * a full UUID (32 hex); the parent id is the first 16 hex of a second UUID.
 *
 * @returns {string}
 */
const generateTraceparent = () => {
  const traceId = randomUUID().replace(/-/g, ''); // 32 hex
  const parentId = randomUUID().replace(/-/g, '').slice(0, 16); // 16 hex
  return `00-${traceId}-${parentId}-01`;
};

/**
 * Resolve a traceparent for a request: accept a valid inbound value, otherwise
 * generate a new trace context. Never returns an untrusted value.
 *
 * @param {unknown} raw
 * @returns {string}
 */
const resolveTraceparent = (raw) => sanitizeTraceparent(raw) || generateTraceparent();

module.exports = {
  sanitizeCorrelationId,
  resolveCorrelationId,
  MAX_CORRELATION_ID_LENGTH,
  sanitizeTraceparent,
  resolveTraceparent,
  generateTraceparent,
};
