const { requestContext } = require('../utils/logger');
const { resolveCorrelationId } = require('../utils/correlation');

/**
 * Attach a correlation ID to each request (H16 / Module 7.4).
 *
 * Honors an inbound `x-request-id` but NEVER trusts it verbatim: the value is
 * sanitized (control chars stripped, length bounded) to prevent log forging
 * and HTTP header/response-splitting injection. When the header is absent or
 * fails validation a fresh UUID is generated. The resolved id is exposed on
 * `req.correlationId`, echoed on the response, and bound to the AsyncLocalStorage
 * request context so every log line and every outbound call to ai_service /
 * genai-service carries it.
 */
const correlationId = (req, res, next) => {
  const id = resolveCorrelationId(req.get('x-request-id'));
  req.correlationId = id;
  res.setHeader('x-request-id', id);
  requestContext.run({ correlationId: id }, next);
};

module.exports = correlationId;
