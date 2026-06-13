function createRateLimiter({ windowMs, maxRequests, message }) {
  const hits = new Map();

  function cleanup() {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.resetTime > windowMs) {
        hits.delete(key);
      }
    }
  }

  return function rateLimit(req, res, next) {
    const userId = req.user?._id?.toString() || req.ip;
    const now = Date.now();

    let entry = hits.get(userId);
    if (!entry || now - entry.resetTime > windowMs) {
      entry = { count: 0, resetTime: now };
      hits.set(userId, entry);
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const auditService = require('../services/auditService');
      auditService.log({
        actor: req.user || null,
        action: 'API_RATE_LIMITED',
        resourceType: 'api',
        resourceId: userId,
        metadata: {
          path: req.originalUrl,
          method: req.method,
          count: entry.count,
          windowMs,
          maxRequests,
        },
        req,
        severity: 'warn',
      });

      return res.status(429).json({
        success: false,
        message: message || 'Too many requests. Please try again later.',
      });
    }

    if (entry.count % 50 === 0) {
      cleanup();
    }

    next();
  };
}

function createChatRateLimiter() {
  return createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 20,
    message: 'Chat rate limit exceeded. Maximum 20 messages per minute.',
  });
}

function createReportRateLimiter() {
  return createRateLimiter({
    windowMs: 60 * 60 * 1000,
    maxRequests: 5,
    message: 'Report rate limit exceeded. Maximum 5 reports per hour.',
  });
}

function createAdminRateLimiter() {
  return createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: parseInt(process.env.ADMIN_RATE_LIMIT_MAX || '200', 10),
    message: 'Admin API rate limit exceeded. Please try again later.',
  });
}

module.exports = { createChatRateLimiter, createReportRateLimiter, createAdminRateLimiter };
