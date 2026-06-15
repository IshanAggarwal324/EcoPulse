const { getRedisClient, isRedisAvailable } = require('../config/redis');

const RATE_LIMIT_PREFIX = 'rl';

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

function createRateLimiter({ windowMs, maxRequests, message }) {
  const hits = new Map();
  let scriptSha = null;
  const redisClient = getRedisClient();

  if (redisClient) {
    redisClient.defineCommand('rlIncrement', {
      numberOfKeys: 1,
      lua: INCREMENT_SCRIPT,
    });
  }

  function cleanup() {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.resetTime > windowMs) {
        hits.delete(key);
      }
    }
  }

  async function redisIncrement(key) {
    const redisKey = `${RATE_LIMIT_PREFIX}:${key}:${windowMs}`;
    try {
      const count = await redisClient.rlIncrement(redisKey, windowMs);
      return count;
    } catch {
      return null;
    }
  }

  return async function rateLimit(req, res, next) {
    const userId = req.user?._id?.toString() || req.ip;
    const now = Date.now();

    const reject = () => {
      const auditService = require('../services/auditService');
      auditService.log({
        actor: req.user || null,
        action: 'API_RATE_LIMITED',
        resourceType: 'api',
        resourceId: userId,
        metadata: {
          path: req.originalUrl,
          method: req.method,
          windowMs,
          maxRequests,
        },
        req,
        severity: 'warn',
      });

      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({
        success: false,
        message: message || 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    };

    if (redisClient && typeof redisClient.rlIncrement === 'function' && isRedisAvailable()) {
      const count = await redisIncrement(userId);
      if (count !== null) {
        if (count > maxRequests) {
          return reject();
        }
        return next();
      }
    }

    let entry = hits.get(userId);
    if (!entry || now - entry.resetTime > windowMs) {
      entry = { count: 0, resetTime: now };
      hits.set(userId, entry);
    }

    entry.count++;

    if (entry.count > maxRequests) {
      return reject();
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

function createAuthRateLimiter({ windowMs, maxRequests, message }) {
  return createRateLimiter({
    windowMs,
    maxRequests,
    message,
  });
}

module.exports = {
  createRateLimiter,
  createChatRateLimiter,
  createReportRateLimiter,
  createAdminRateLimiter,
  createAuthRateLimiter,
};
