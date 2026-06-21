const ApiError = require('../utils/apiError');

const mapKnownError = (err) => {
  if (err instanceof ApiError) return err;

  if (err?.type === 'entity.parse.failed') {
    return new ApiError('Invalid JSON body', 400, 'INVALID_JSON');
  }

  if (err?.name === 'ValidationError') {
    const messages = Object.values(err.errors || {})
      .map((entry) => entry?.message)
      .filter(Boolean);
    return new ApiError('Validation failed', 400, 'VALIDATION_ERROR', messages);
  }

  if (err?.name === 'CastError') {
    const message = `Invalid ${err.path || 'resource'} value`;
    return new ApiError(message, 400, 'INVALID_REFERENCE');
  }

  if (err?.code === 11000) {
    const fields = Object.keys(err?.keyPattern || {});
    const message = fields.length
      ? `Duplicate value for: ${fields.join(', ')}`
      : 'Duplicate value violation';
    return new ApiError(message, 409, 'DUPLICATE_KEY', fields);
  }

  if (err?.name === 'TokenExpiredError') {
    return new ApiError('Access token expired', 401, 'TOKEN_EXPIRED');
  }

  if (err?.name === 'JsonWebTokenError') {
    return new ApiError('Invalid token', 401, 'TOKEN_INVALID');
  }

  const statusCode = err?.statusCode || (typeof err?.status === 'number' ? err.status : 500);
  const code = err?.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && statusCode >= 500) {
    return new ApiError('Internal server error', 500, 'INTERNAL_ERROR', null);
  }

  return new ApiError(err?.message || 'Internal server error', statusCode, code, err?.details || null);
};

const errorHandler = (err, req, res, next) => {
  const normalized = mapKnownError(err);
  const statusCode = normalized.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  const requestId = req.headers['x-request-id'] || null;
  const isProduction = process.env.NODE_ENV === 'production';

  const logPrefix = requestId ? `[Error][${requestId}]` : '[Error]';

  if (statusCode >= 500) {
    console.error(`${logPrefix} ${normalized.message}`);
    if (err?.stack) console.error(err.stack);
  } else {
    console.error(`${logPrefix} ${normalized.message}`);
  }

  res.status(statusCode).json({
    success: false,
    status: 'error',
    code: normalized.code,
    message: normalized.message,
    errors: Array.isArray(normalized.details) ? normalized.details : undefined,
    details:
      normalized.details && !Array.isArray(normalized.details)
        ? normalized.details
        : undefined,
    requestId,
    stack: process.env.NODE_ENV === 'production' ? null : normalized.stack,
  });
};

module.exports = errorHandler;
