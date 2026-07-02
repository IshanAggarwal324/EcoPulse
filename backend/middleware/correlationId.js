const { requestContext } = require('../utils/logger');
const {
  resolveCorrelationId,
  sanitizeTraceparent,
  generateTraceparent,
} = require('../utils/correlation');

/**
 * Attach a correlation ID and W3C traceparent to each request (H16 / Module
 * 7.4 / Module 7.6).
 *
 * Honors inbound `x-request-id` and `traceparent` headers but NEVER trusts them
 * verbatim: values are sanitized/validated (control chars stripped; traceparent
 * matched against the exact W3C grammar; length bounded) to prevent log forging
 * and HTTP header/response-splitting injection. When a header is absent or fails
 * validation a fresh id is generated. The resolved values are exposed on `req`,
 * echoed on the response, and bound to the AsyncLocalStorage request context so
 * every log line and every outbound call to ai_service / genai-service carries
 * them.
 *
 * A valid inbound `traceparent` is always honored. When none is present, a fresh
 * trace context is minted so a future OpenTelemetry collector always has a
 * parent span — set `TRACEPARENT_ENABLED=false` to opt out of generation while
 * still honoring valid inbound values. A malformed inbound value is always
 * rejected (never trusted), and only replaced by a fresh one when generation is
 * enabled.
 */
const traceparentGenerationEnabled = () =>
  String(process.env.TRACEPARENT_ENABLED || 'true').toLowerCase() !== 'false';

const correlationId = (req, res, next) => {
  const id = resolveCorrelationId(req.get('x-request-id'));
  req.correlationId = id;
  res.setHeader('x-request-id', id);

  const inboundValid = sanitizeTraceparent(req.get('traceparent'));
  let traceparent = inboundValid;
  if (!traceparent && traceparentGenerationEnabled()) {
    traceparent = generateTraceparent();
  }
  if (traceparent) {
    req.traceparent = traceparent;
    res.setHeader('traceparent', traceparent);
  }

  requestContext.run({ correlationId: id, traceparent: traceparent || null }, next);
};

module.exports = correlationId;
