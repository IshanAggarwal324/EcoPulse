const { getRedisClient, isRedisAvailable } = require('../config/redis');
const { createMemoryStore } = require('./rateLimitMemory');

const RATE_LIMIT_PREFIX = 'rl';

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

function createRateLimiter({ windowMs, maxRequests, message }) {
  const memoryStore = createMemoryStore(windowMs);
  let scriptSha = null;
  const redisClient = getRedisClient();

  if (redisClient) {
    redisClient.defineCommand('rlIncrement', {
      numberOfKeys: 1,
      lua: INCREMENT_SCRIPT,
    });
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
      }).catch(() => {});

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

    const count = memoryStore.increment(userId);
    if (count > maxRequests) {
      return reject();
    }

    return next();
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

function createForecastRateLimiter() {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: parseInt(process.env.FORECAST_RATE_LIMIT_MAX || '30', 10),
    message: 'Forecast rate limit exceeded. Please try again later.',
  });
}

function createAnomalyRateLimiter() {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: parseInt(process.env.ANOMALY_RATE_LIMIT_MAX || '30', 10),
    message: 'Anomaly rate limit exceeded. Please try again later.',
  });
}

function createProfileRateLimiter() {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 20,
    message: 'Too many profile update attempts. Please try again later.',
  });
}

function createPreviewRateLimiter() {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 30,
    message: 'Too many report preview requests. Please try again later.',
  });
}

function createApiRateLimiter() {
  return createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: parseInt(process.env.API_RATE_LIMIT_MAX || '120', 10),
    message: 'API rate limit exceeded. Please try again later.',
  });
}

module.exports = {
  createRateLimiter,
  createChatRateLimiter,
  createReportRateLimiter,
  createAdminRateLimiter,
  createAuthRateLimiter,
  createForecastRateLimiter,
  createAnomalyRateLimiter,
  createProfileRateLimiter,
  createPreviewRateLimiter,
  createApiRateLimiter,
};
