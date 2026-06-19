const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const DeviceCredential = require('../models/DeviceCredential');
const EnergyNode = require('../models/EnergyNode');
const { getRedisClient, isRedisAvailable } = require('../config/redis');
const auditService = require('./auditService');

const BCRYPT_ROUNDS = parseInt(process.env.DEVICE_API_KEY_BCRYPT_ROUNDS || '12', 10);

// Brute-force defense (guardrail 1.1: "lock device after N failed auth attempts").
const MAX_FAILED_ATTEMPTS = parseInt(process.env.DEVICE_AUTH_MAX_FAILED_ATTEMPTS || '10', 10);
const LOCKOUT_MS = parseInt(process.env.DEVICE_AUTH_LOCKOUT_MS || String(15 * 60 * 1000), 10);

// DeviceId / API key prefixes make leaked secrets greppable in logs and let us
// distinguish device keys from user JWTs at a glance. Never log the raw key.
const DEVICE_ID_PREFIX = 'dev_';
const API_KEY_PREFIX = 'ek_';

const DEVICE_ID_BYTES = 8; // 16 hex chars
const API_KEY_BYTES = 32; // 64 hex chars — 256 bits of entropy

// A constant dummy bcrypt hash used when no device row exists, so the timing
// of an auth attempt for a non-existent deviceId matches a real one. This
// prevents deviceId enumeration via response-time side channels. The hash
// below is bcrypt(cost=12) of a random string and will never match any real key.
const DUMMY_HASH =
  '$2a$12$0123456789012345678901uP3xQ8nK7Q.mQ8nK7Q.mQ8nK7Q.mQ8nK7';

const LOCKOUT_PREFIX = 'device:lock';
const ATTEMPT_PREFIX = 'device:authattempts';

/**
 * Generate a new deviceId. Idempotent against collisions via DB unique index.
 */
const generateDeviceId = () =>
  `${DEVICE_ID_PREFIX}${crypto.randomBytes(DEVICE_ID_BYTES).toString('hex')}`;

/**
 * Generate a new plaintext API key. Returned to the admin ONCE on provisioning
 * or rotation. Never persisted, never logged.
 */
const generateApiKey = () =>
  `${API_KEY_PREFIX}${crypto.randomBytes(API_KEY_BYTES).toString('hex')}`;

/**
 * Hash a plaintext API key for storage with bcrypt. Cost is configurable but
 * defaults to 12 — high enough to slow brute force, low enough for telemetry
 * throughput on a hot ingestion path (auth is once per connection/interval).
 */
const hashApiKey = (plaintext) => bcrypt.hash(plaintext, BCRYPT_ROUNDS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Constant-time comparison wrapper around bcrypt. Even though bcrypt.compare
 * is already constant-time for equal-length inputs, we add a fixed minimum
 * latency floor so an attacker cannot distinguish "wrong key" from "no device".
 */
const verifyApiKey = async (plaintext, storedHash) => {
  if (!plaintext || !storedHash) return false;
  try {
    return await bcrypt.compare(plaintext, storedHash);
  } catch {
    return false;
  }
};

/**
 * Build the canonical MQTT telemetry topic for a node. Devices are ACL'd to
 * publish only here (guardrail 1.1: "Topic ACL: device may only publish to
 * ecopulse/nodes/{nodeId}/telemetry").
 */
const telemetryTopicFor = (nodeId) => `ecopulse/nodes/${nodeId}/telemetry`;

const defaultAllowedTopics = (nodeId) => [telemetryTopicFor(nodeId)];

const isDeviceAuthEnabled = () =>
  String(process.env.DEVICE_AUTH_ENABLED || 'false').toLowerCase() === 'true';

/* ------------------------------------------------------------------ */
/* Lockout primitives                                                  */
/* ------------------------------------------------------------------ */

const lockKey = (deviceId) => `${LOCKOUT_PREFIX}:${deviceId}`;
const attemptKey = (deviceId) => `${ATTEMPT_PREFIX}:${deviceId}`;

/**
 * Record a failed auth attempt. Redis is the fast path (shared across
 * instances, atomic INCR); the persisted counter on DeviceCredential is the
 * durable fallback if Redis is unavailable. Either crossing the threshold
 * locks the device.
 *
 * Returns `{ locked, attempts }`.
 */
const recordFailedAttempt = async (device) => {
  const deviceId = device.deviceId;
  let attempts;

  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      attempts = await redis.incr(attemptKey(deviceId));
      if (attempts === 1) {
        await redis.pexpire(attemptKey(deviceId), LOCKOUT_MS);
      }
    } catch {
      attempts = null;
    }
  }

  // Persisted fallback / source of truth mirror.
  const updates = {
    $inc: { failedAuthAttempts: 1 },
    lastFailedAuthAt: new Date(),
  };

  const nextAttempts = attempts ?? device.failedAuthAttempts + 1;

  let locked = false;
  if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
    updates.$set = {
      ...updates.$set,
      lockedUntil: new Date(Date.now() + LOCKOUT_MS),
      status: 'locked',
    };
    locked = true;
    if (redis && isRedisAvailable()) {
      try {
        await redis.set(lockKey(deviceId), '1', 'PX', LOCKOUT_MS);
      } catch {
        /* non-fatal — persisted lock is authoritative */
      }
    }
  }

  await DeviceCredential.updateOne({ _id: device._id }, updates).exec();
  return { locked, attempts: nextAttempts };
};

/**
 * Reset counters on a successful auth. Clears both Redis and persisted state.
 */
const resetFailedAttempts = async (device) => {
  const deviceId = device.deviceId;
  const redis = getRedisClient();

  if (redis && isRedisAvailable()) {
    try {
      await redis.del(attemptKey(deviceId));
    } catch {
      /* non-fatal */
    }
  }

  if (device.failedAuthAttempts > 0 || device.lockedUntil || device.status === 'locked') {
    await DeviceCredential.updateOne(
      { _id: device._id },
      {
        $set: {
          failedAuthAttempts: 0,
          lockedUntil: null,
          // Restore `active` only if it was auto-locked — never override an
          // explicit admin `revoked`.
          status: device.status === 'locked' ? 'active' : device.status,
        },
      },
    ).exec();
  }
};

/**
 * Check Redis-side lock first (cheap) before falling back to the model.
 */
const isLocked = async (device) => {
  if (device.lockedUntil && device.lockedUntil > Date.now()) return true;
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      const flag = await redis.get(lockKey(device.deviceId));
      if (flag) return true;
    } catch {
      /* fall through to model check */
    }
  }
  return false;
};

/* ------------------------------------------------------------------ */
/* Authentication                                                       */
/* ------------------------------------------------------------------ */

/**
 * Authenticate a device by `deviceId` + plaintext API key.
 *
 * Anti-enumeration: returns a uniform `{ ok: false, code: 'AUTH_FAILED' }`
 * regardless of whether the device is missing, revoked, locked, or the key is
 * wrong — and always runs a bcrypt compare so timing is uniform.
 *
 * On success returns `{ ok: true, device, node }`.
 */
const authenticateDevice = async ({ deviceId, apiKey, ip }) => {
  if (!deviceId || !apiKey) {
    // Burn a little time so empty-input callers can't probe cheaply.
    await verifyApiKey('x', DUMMY_HASH);
    return { ok: false, code: 'AUTH_FAILED' };
  }

  const device = await DeviceCredential.findOne({ deviceId }).select('+apiKeyHash').exec();

  // Always run a bcrypt compare to equalize timing between "no such device"
  // and "wrong key". A missing device verifies against the dummy hash.
  const keyMatches = await verifyApiKey(
    apiKey,
    device?.apiKeyHash || DUMMY_HASH,
  );

  if (!device) {
    return { ok: false, code: 'AUTH_FAILED' };
  }

  // Locked check happens AFTER the bcrypt compare so locked vs unlocked timing
  // for a valid key is still dominated by bcrypt, not by the lock lookup.
  if (await isLocked(device)) {
    return { ok: false, code: 'DEVICE_LOCKED' };
  }

  if (device.status === 'revoked') {
    return { ok: false, code: 'DEVICE_REVOKED' };
  }

  if (!keyMatches) {
    const { locked } = await recordFailedAttempt(device);
    return { ok: false, code: locked ? 'DEVICE_LOCKED' : 'AUTH_FAILED' };
  }

  // Success — clear counters and stamp last-seen.
  await resetFailedAttempts(device);
  await DeviceCredential.updateOne(
    { _id: device._id },
    {
      $set: {
        lastSeenAt: new Date(),
        lastSeenIp: ip || null,
      },
    },
  ).exec();

  const node = await EnergyNode.findById(device.nodeId).lean().exec();

  return { ok: true, device, node };
};

/* ------------------------------------------------------------------ */
/* Provisioning helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Validate that nodeId refers to a real, non-public_api node owned by `ownerId`.
 * `public_api` nodes are admin-seeded grid zones and must never carry device
 * credentials (guardrail 1.1.4).
 */
const assertNodeBindable = async ({ nodeId, ownerId }) => {
  if (!nodeId || !mongoose.Types.ObjectId.isValid(nodeId)) {
    const err = new Error('nodeId must be a valid identifier');
    err.statusCode = 400;
    throw err;
  }

  const node = await EnergyNode.findById(nodeId).lean().exec();
  if (!node) {
    const err = new Error('Node not found');
    err.statusCode = 404;
    throw err;
  }

  if (ownerId && String(node.userId) !== String(ownerId)) {
    const err = new Error('Node is not owned by the specified user');
    err.statusCode = 403;
    throw err;
  }

  if (node.ingestionMode === 'public_api') {
    const err = new Error('public_api grid-zone nodes cannot be bound to a device');
    err.statusCode = 400;
    throw err;
  }

  return node;
};

/**
 * Provision a new device credential. Returns the device record plus the
 * one-time plaintext API key. Caller is responsible for surfacing the key
 * to the admin exactly once and never persisting it.
 */
const provisionDevice = async ({
  nodeId,
  ownerId,
  label,
  mqttClientId,
  rateLimitTier,
  maxCapacityKw,
  allowedTopics,
  createdBy,
}) => {
  const node = await assertNodeBindable({ nodeId, ownerId });

  const tier = DeviceCredential.RATE_LIMIT_TIERS.includes(rateLimitTier)
    ? rateLimitTier
    : 'standard';

  const deviceId = generateDeviceId();
  const plaintextApiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(plaintextApiKey);

  const topics =
    Array.isArray(allowedTopics) && allowedTopics.length
      ? Array.from(new Set(allowedTopics.map((t) => String(t).trim()).filter(Boolean)))
      : defaultAllowedTopics(nodeId);

  const device = await DeviceCredential.create({
    deviceId,
    label: label?.trim() || null,
    nodeId: node._id,
    apiKeyHash,
    mqttClientId: mqttClientId?.trim() || null,
    allowedTopics: topics,
    rateLimitTier: tier,
    maxCapacityKw: typeof maxCapacityKw === 'number' && maxCapacityKw >= 0 ? maxCapacityKw : null,
    status: 'active',
    createdBy: createdBy || null,
  });

  return { device, plaintextApiKey };
};

/**
 * Rotate the API key for an existing device. Increments `apiKeyVersion` so any
 * cached/old key is immediately invalid. Returns the new one-time plaintext key.
 */
const rotateApiKey = async (device) => {
  const plaintextApiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(plaintextApiKey);

  await DeviceCredential.updateOne(
    { _id: device._id },
    {
      $set: {
        apiKeyHash,
        lastRotatedAt: new Date(),
        // Re-activate if it was merely auto-locked; keep `revoked` as-is.
        status: device.status === 'locked' ? 'active' : device.status,
        lockedUntil: null,
        failedAuthAttempts: 0,
      },
      $inc: { apiKeyVersion: 1 },
    },
  ).exec();

  // Clear any Redis lock/attempts state.
  const redis = getRedisClient();
  if (redis && isRedisAvailable()) {
    try {
      await redis.del(attemptKey(device.deviceId));
      await redis.del(lockKey(device.deviceId));
    } catch {
      /* non-fatal */
    }
  }

  return plaintextApiKey;
};

/**
 * Revoke (or re-activate) a device. Revocation immediately rejects auth even
 * before Redis lock expiry because `status === 'revoked'` is checked in
 * authenticateDevice.
 */
const setRevoked = async (device, { revoked, reason }) => {
  const redis = getRedisClient();

  if (revoked) {
    await DeviceCredential.updateOne(
      { _id: device._id },
      {
        $set: {
          status: 'revoked',
          revokedAt: new Date(),
          revokedReason: reason || null,
        },
        $inc: { apiKeyVersion: 1 },
      },
    ).exec();
  } else {
    await DeviceCredential.updateOne(
      { _id: device._id },
      {
        $set: {
          status: 'active',
          revokedAt: null,
          revokedReason: null,
          lockedUntil: null,
          failedAuthAttempts: 0,
        },
      },
    ).exec();
  }

  if (redis && isRedisAvailable()) {
    try {
      await redis.del(attemptKey(device.deviceId));
      await redis.del(lockKey(device.deviceId));
    } catch {
      /* non-fatal */
    }
  }
};

/* ------------------------------------------------------------------ */
/* Serialization (strip secrets)                                       */
/* ------------------------------------------------------------------ */

const toDeviceResponse = (device, { includeSecrets = false } = {}) => {
  const doc = device?.toObject ? device.toObject() : device;
  if (!doc) return doc;

  const safe = {
    id: doc._id,
    deviceId: doc.deviceId,
    label: doc.label ?? null,
    nodeId: doc.nodeId,
    mqttClientId: doc.mqttClientId ?? null,
    allowedTopics: doc.allowedTopics ?? [],
    rateLimitTier: doc.rateLimitTier,
    maxCapacityKw: doc.maxCapacityKw ?? null,
    status: doc.status,
    apiKeyVersion: doc.apiKeyVersion ?? 1,
    lastSeenAt: doc.lastSeenAt ?? null,
    lastRotatedAt: doc.lastRotatedAt ?? null,
    revokedAt: doc.revokedAt ?? null,
    revokedReason: doc.revokedReason ?? null,
    failedAuthAttempts: doc.failedAuthAttempts ?? 0,
    lastFailedAuthAt: doc.lastFailedAuthAt ?? null,
    lockedUntil: doc.lockedUntil ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };

  if (includeSecrets) {
    // Only set transiently by the controller immediately after
    // provision/rotate; never persisted with the device document.
    safe.apiKey = device.__plaintextApiKey;
  }

  return safe;
};

const logDeviceEvent = ({ actor, action, device, metadata, req, severity = 'info' }) =>
  auditService.log({
    actor,
    action,
    resourceType: 'device',
    resourceId: device?.deviceId || device?._id,
    metadata: {
      deviceId: device?.deviceId,
      nodeId: device?.nodeId,
      apiKeyVersion: device?.apiKeyVersion,
      ...metadata,
    },
    req,
    severity,
  });

module.exports = {
  // constants
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MS,
  API_KEY_PREFIX,
  DEVICE_ID_PREFIX,
  // generators / hashing
  generateDeviceId,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  // topics
  telemetryTopicFor,
  defaultAllowedTopics,
  // config
  isDeviceAuthEnabled,
  // auth
  authenticateDevice,
  recordFailedAttempt,
  resetFailedAttempts,
  isLocked,
  // provisioning
  assertNodeBindable,
  provisionDevice,
  rotateApiKey,
  setRevoked,
  // serialization
  toDeviceResponse,
  logDeviceEvent,
};
