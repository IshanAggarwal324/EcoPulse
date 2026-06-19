const { getRedisClient, isRedisAvailable } = require('../config/redis');

/**
 * Per-device telemetry rate limiter (guardrail 1.1: "Per-device rate limits").
 *
 * Distinct from the user-facing createRateLimiter because:
 *  - The limiter key is `req.device.deviceId`, set by the `deviceAuth` middleware
 *    (devices are not users and carry no JWT).
 *  - Limits are tier-driven (standard / high / unrestricted) so different
 *    hardware profiles get different throughput ceilings.
 *
 * Falls back to in-memory when Redis is unavailable, mirroring the pattern in
 * rateLimit.js. `unrestricted` tier is a no-op pass-through.
 */

const TIER_CONFIG = {
  standard: {
    windowMs: parseInt(process.env.DEVICE_TIER_STANDARD_WINDOW_MS || '60000', 10),
    maxRequests: parseInt(process.env.DEVICE_TIER_STANDARD_MAX || '60', 10),
  },
  high: {
    windowMs: parseInt(process.env.DEVICE_TIER_HIGH_WINDOW_MS || '60000', 10),
    maxRequests: parseInt(process.env.DEVICE_TIER_HIGH_MAX || '300', 10),
  },
  unrestricted: null,
};

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

const PREFIX = 'devrl';
let scriptRegistered = false;

const ensureRedisScript = () => {
  const client = getRedisClient();
  if (client && !scriptRegistered) {
    client.defineCommand('devRlIncrement', { numberOfKeys: 1, lua: INCREMENT_SCRIPT });
    scriptRegistered = true;
  }
};

function createDeviceTelemetryRateLimiter() {
  const memoryBuckets = new Map();

  const cleanup = () => {
    const now = Date.now();
    for (const [key, entry] of memoryBuckets) {
      if (now - entry.resetTime > entry.windowMs) memoryBuckets.delete(key);
    }
  };

  return async function deviceTelemetryRateLimit(req, res, next) {
    const device = req.device;
    const tier = device?.rateLimitTier || 'standard';
    const config = TIER_CONFIG[tier];

    if (!config) {
      // unrestricted (or unknown) tier — pass through.
      return next();
    }

    const { windowMs, maxRequests } = config;
    const deviceId = device?.deviceId || req.ip;
    const key = `${PREFIX}:${deviceId}:${windowMs}`;

    const client = getRedisClient();
    if (client && isRedisAvailable() && typeof client.devRlIncrement === 'function') {
      try {
        const count = await client.devRlIncrement(key, windowMs);
        if (count > maxRequests) {
          res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
          return res.status(429).json({
            success: false,
            message: 'Device telemetry rate limit exceeded',
            code: 'DEVICE_RATE_LIMITED',
            retryAfter: Math.ceil(windowMs / 1000),
          });
        }
        return next();
      } catch {
        /* fall back to in-memory */
      }
    }

    ensureRedisScript();

    const now = Date.now();
    let entry = memoryBuckets.get(key);
    if (!entry || now - entry.resetTime > windowMs) {
      entry = { count: 0, resetTime: now, windowMs };
      memoryBuckets.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > maxRequests) {
      if (entry.count % 50 === 0) cleanup();
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({
        success: false,
        message: 'Device telemetry rate limit exceeded',
        code: 'DEVICE_RATE_LIMITED',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    }

    if (entry.count % 50 === 0) cleanup();
    return next();
  };
}

module.exports = { createDeviceTelemetryRateLimiter, TIER_CONFIG };
