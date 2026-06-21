const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

let client = null;
let connecting = false;

const buildTlsOptions = (redisUrl) => {
  if (!redisUrl.startsWith('rediss://')) {
    return undefined;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const allowInsecure = process.env.REDIS_TLS_INSECURE === 'true';

  if (isProduction && allowInsecure) {
    throw new Error('REDIS_TLS_INSECURE is not allowed in production');
  }

  const tls = {
    rejectUnauthorized: !allowInsecure,
  };

  const caPath = process.env.REDIS_TLS_CA_CERT;
  if (caPath) {
    tls.ca = fs.readFileSync(path.resolve(caPath));
  }

  return tls;
};

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

  const tls = buildTlsOptions(redisUrl);
  const options = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 500, 3000);
    },
    ...(tls ? { tls } : {}),
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

async function disconnectRedis() {
  if (!client) return;

  const active = client;
  client = null;
  connecting = false;

  try {
    if (active.status === 'end' || active.status === 'close') return;
    await active.quit();
  } catch {
    try {
      active.disconnect();
    } catch {
      /* ignore */
    }
  }
}

function isRedisAvailable() {
  return client !== null && client.status === 'ready';
}

module.exports = { getRedisClient, isRedisAvailable, disconnectRedis, buildTlsOptions };
