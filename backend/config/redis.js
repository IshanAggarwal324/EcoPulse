const Redis = require('ioredis');

let client = null;
let connecting = false;

function getRedisClient() {
  const redisUrl = process.env.REDIS_URL || process.env.REDIS_TLS_URL;

  if (!redisUrl) {
    return null;
  }

  if (client) {
    return client;
  }

  if (connecting) {
    return null;
  }

  connecting = true;

  const options = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 500, 3000);
    },
    ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
  };

  client = new Redis(redisUrl, options);

  client.on('error', (err) => {
    console.error('Redis error:', err.message);
  });

  client.on('connect', () => {
    console.log('Redis connected for distributed rate limiting');
  });

  client.on('close', () => {
    console.warn('Redis connection closed — rate limiting falls back to in-memory');
  });

  connecting = false;
  return client;
}

function isRedisAvailable() {
  return client !== null && client.status === 'ready';
}

module.exports = { getRedisClient, isRedisAvailable };
