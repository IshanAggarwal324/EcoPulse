const ApiError = require('../utils/apiError');

/**
 * Terminal middleware for unmatched routes.
 *
 * errorHandler derives the response status from the error itself and ignores
 * `res.statusCode`, so a plain `Error` (even after `res.status(404)`) is
 * reported as `500 INTERNAL_ERROR`. That polluted 5xx metrics and alerting with
 * ordinary mistyped URLs and bot probes. Passing an ApiError makes the 404
 * explicit.
 */
const notFound = (req, res, next) => {
  next(new ApiError(`Not Found - ${req.originalUrl}`, 404, 'NOT_FOUND'));
};

module.exports = notFound;
