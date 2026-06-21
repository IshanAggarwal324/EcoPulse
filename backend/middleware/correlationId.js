const { randomUUID } = require('crypto');
const { requestContext } = require('../utils/logger');

/**
 * Attach a correlation ID to each request (H16).
 * Honors inbound x-request-id; otherwise generates a UUID.
 */
const correlationId = (req, res, next) => {
  const id = String(req.get('x-request-id') || randomUUID());
  req.correlationId = id;
  res.setHeader('x-request-id', id);
  requestContext.run({ correlationId: id }, next);
};

module.exports = correlationId;
